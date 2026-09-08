-- Pending replay-capacity schema for the original OCC journal.
-- Reserve permanent capacity before activation. There is no second mutex/store.
-- Owner lock order: existing installation intake J, sorted channel parents,
-- Namespace, Agent, exact head, lineage/barrier/progress. This SQL never takes a
-- later advisory lock and never treats a SQL session variable as authority.
-- TODO: the original owner must supply the actual activation/clock validator,
-- mandatory audit and durable progress responsibility composition before the
-- deliberately closed activation/publication guards can be replaced.

CREATE FUNCTION occ.turn_journal_replay_keys(v jsonb, VARIADIC expected text[])
RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, occ AS $$
  SELECT CASE WHEN jsonb_typeof(v) = 'object' THEN
    (SELECT array_agg(k ORDER BY k COLLATE "C") FROM jsonb_object_keys(v) AS k)
      IS NOT DISTINCT FROM
    (SELECT array_agg(k ORDER BY k COLLATE "C") FROM unnest(expected) AS k)
  ELSE false END
$$;
--> statement-breakpoint
CREATE FUNCTION occ.turn_journal_replay_reference_valid(v jsonb)
RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, occ AS $$
 SELECT COALESCE(jsonb_typeof(v)='string' AND v#>>'{}' ~ '^[A-Za-z0-9._:/-]{1,200}$'
   AND v#>>'{}' !~ '^[A-Za-z][A-Za-z0-9+.-]*://', false)
$$;
--> statement-breakpoint
CREATE FUNCTION occ.turn_journal_replay_manifest_reference_valid(v jsonb)
RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, occ AS $$
 SELECT COALESCE(jsonb_typeof(v)='string' AND v#>>'{}' ~ '^[A-Za-z0-9._:/-]{1,200}$', false)
$$;
--> statement-breakpoint
CREATE FUNCTION occ.turn_journal_replay_version(v jsonb, minimum bigint DEFAULT 1)
RETURNS boolean LANGUAGE plpgsql IMMUTABLE SET search_path = pg_catalog, occ AS $$
BEGIN
 IF jsonb_typeof(v) IS DISTINCT FROM 'number' THEN RETURN false; END IF;
 RETURN (v#>>'{}')::numeric BETWEEN minimum AND 9007199254740991
   AND trunc((v#>>'{}')::numeric) = (v#>>'{}')::numeric;
END;
$$;
--> statement-breakpoint
CREATE FUNCTION occ.turn_journal_replay_id(v jsonb, prefix text)
RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, occ AS $$
 SELECT COALESCE(jsonb_typeof(v)='string' AND v#>>'{}' ~
  ('^'||prefix||'_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'), false)
$$;
--> statement-breakpoint
CREATE FUNCTION occ.turn_journal_replay_scope(v jsonb)
RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, occ AS $$
 SELECT occ.turn_journal_replay_keys(v,'installationId','namespaceId','agentId')
 AND occ.turn_journal_replay_id(v->'installationId','ins')
 AND occ.turn_journal_replay_id(v->'namespaceId','ns')
 AND occ.turn_journal_replay_id(v->'agentId','agt')
$$;
--> statement-breakpoint
CREATE FUNCTION occ.turn_journal_replay_canonical(v jsonb)
RETURNS text LANGUAGE plpgsql IMMUTABLE STRICT SET search_path = pg_catalog, occ AS $$
DECLARE result text;
BEGIN
 CASE jsonb_typeof(v)
 WHEN 'object' THEN
  SELECT '{'||COALESCE(string_agg(to_jsonb(k)::text||':'||occ.turn_journal_replay_canonical(x),',' ORDER BY k COLLATE "C"),'')||'}'
    INTO result FROM jsonb_each(v) AS e(k,x);
 WHEN 'array' THEN
  SELECT '['||COALESCE(string_agg(occ.turn_journal_replay_canonical(x),',' ORDER BY n),'')||']'
    INTO result FROM jsonb_array_elements(v) WITH ORDINALITY AS e(x,n);
 ELSE result := v::text;
 END CASE;
 RETURN result;
END;
$$;
--> statement-breakpoint
CREATE FUNCTION occ.turn_journal_replay_digest(v jsonb)
RETURNS text LANGUAGE sql IMMUTABLE STRICT SET search_path = pg_catalog, occ AS $$
 SELECT encode(sha256(convert_to(occ.turn_journal_replay_canonical(v),'UTF8')),'hex')
$$;
--> statement-breakpoint
CREATE FUNCTION occ.turn_journal_replay_bounded(v jsonb, bytes integer, depth integer, nodes integer)
RETURNS boolean LANGUAGE plpgsql IMMUTABLE SET search_path = pg_catalog, occ AS $$
DECLARE n bigint; d integer;
BEGIN
 IF v IS NULL OR octet_length(v::text) > bytes*2 THEN RETURN false; END IF;
 WITH RECURSIVE tree(x,level) AS (
  SELECT v,0 UNION ALL
  SELECT c.x,t.level+1 FROM tree t CROSS JOIN LATERAL (
   SELECT value AS x FROM jsonb_each(CASE WHEN jsonb_typeof(t.x)='object' THEN t.x ELSE '{}'::jsonb END)
   UNION ALL
   SELECT value AS x FROM jsonb_array_elements(CASE WHEN jsonb_typeof(t.x)='array' THEN t.x ELSE '[]'::jsonb END)
  ) c WHERE t.level <= depth
 ) SELECT count(*),max(level) INTO n,d FROM tree;
 IF n > nodes OR d > depth THEN RETURN false; END IF;
 RETURN octet_length(occ.turn_journal_replay_canonical(v)) <= bytes;
END;
$$;
--> statement-breakpoint
CREATE FUNCTION occ.turn_journal_replay_identity_valid(v jsonb, s jsonb)
RETURNS boolean LANGUAGE plpgsql IMMUTABLE SET search_path = pg_catalog, occ AS $$
DECLARE c jsonb;
BEGIN
 IF NOT occ.turn_journal_replay_scope(s) OR NOT occ.turn_journal_replay_version(v->'activationGeneration') THEN RETURN false; END IF;
 CASE v->>'kind'
 WHEN 'route' THEN RETURN occ.turn_journal_replay_keys(v,'kind','routeRef','routeVersion','activationGeneration')
   AND occ.turn_journal_replay_manifest_reference_valid(v->'routeRef') AND occ.turn_journal_replay_version(v->'routeVersion');
 WHEN 'context' THEN
  c:=v->'context';
  RETURN occ.turn_journal_replay_keys(v,'kind','context','creationRef','activationGeneration')
   AND occ.turn_journal_replay_keys(c,'installationRef','namespaceRef','agentRef','conversationRef')
   AND (c->'installationRef'=s->'installationId' AND c->'namespaceRef'=s->'namespaceId' AND c->'agentRef'=s->'agentId') IS TRUE
   AND occ.turn_journal_replay_manifest_reference_valid(c->'conversationRef') AND occ.turn_journal_replay_manifest_reference_valid(v->'creationRef');
 WHEN 'channel-installation' THEN RETURN occ.turn_journal_replay_keys(v,'kind','channelInstallationRef','installationGeneration','activationGeneration')
   AND occ.turn_journal_replay_id(v->'channelInstallationRef','chi') AND occ.turn_journal_replay_version(v->'installationGeneration');
 ELSE RETURN false;
 END CASE;
END;
$$;
--> statement-breakpoint
CREATE FUNCTION occ.turn_journal_replay_native_ref(v jsonb)
RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, occ AS $$
 -- Match the supported channel binding datum domain without normalizing it.
 -- PostgreSQL jsonb/text already rejects unpaired surrogates and U+0000.
 -- Metadata validity does not replace original native-envelope authentication.
 SELECT COALESCE(jsonb_typeof(v)='string'
  AND octet_length(convert_to(v#>>'{}','UTF8')) BETWEEN 1 AND 1024
  AND (v#>>'{}') COLLATE "C" !~ ('['||chr(1)||'-'||chr(31)||chr(127)||'-'||chr(159)||']'), false)
$$;
--> statement-breakpoint
CREATE FUNCTION occ.turn_journal_replay_route_valid(r jsonb, i text, ch text)
RETURNS boolean LANGUAGE plpgsql IMMUTABLE SET search_path = pg_catalog, occ AS $$
DECLARE native jsonb; conversation jsonb;
BEGIN
 native:=r->'native'; conversation:=native->'nativeConversation';
 RETURN occ.turn_journal_replay_keys(r,'routeKey','native')
  AND (jsonb_typeof(r->'routeKey')='string' AND r->>'routeKey' ~ '^[0-9a-f]{64}$') IS TRUE
  AND occ.turn_journal_replay_keys(native,'installationRef','channelInstallationRef','platform','providerTenantRef','recipientAppRef','nativeConversation')
  AND (native->>'installationRef'=i AND native->>'channelInstallationRef'=ch) IS TRUE
  AND occ.turn_journal_replay_native_ref(native->'providerTenantRef')
  AND occ.turn_journal_replay_native_ref(native->'recipientAppRef')
  AND occ.turn_journal_replay_keys(conversation,'channelRef','scope','rootThreadRef')
  AND occ.turn_journal_replay_native_ref(conversation->'channelRef')
  AND occ.turn_journal_replay_native_ref(conversation->'rootThreadRef')
  AND ((native->>'platform'='slack' AND conversation->>'scope'='slack-private-channel')
    OR (native->>'platform'='msteams' AND conversation->>'scope'='teams-standard-channel')) IS TRUE;
END;
$$;
--> statement-breakpoint
CREATE FUNCTION occ.turn_journal_replay_target_valid(v jsonb, i text, n text, a text, ch text)
RETURNS boolean LANGUAGE plpgsql IMMUTABLE SET search_path = pg_catalog, occ AS $$
BEGIN
 IF NOT occ.turn_journal_replay_bounded(v,16384,16,16384)
 OR NOT occ.turn_journal_replay_keys(v,'schemaVersion','scope','channelInstallationRef','identity','route')
 OR (v->'schemaVersion'='1'::jsonb AND v->'scope'=jsonb_build_object('installationId',i,'namespaceId',n,'agentId',a)
   AND v->>'channelInstallationRef'=ch) IS NOT TRUE
 OR NOT occ.turn_journal_replay_id(v->'channelInstallationRef','chi')
 OR NOT occ.turn_journal_replay_identity_valid(v->'identity',v->'scope') THEN RETURN false; END IF;
 IF v#>>'{identity,kind}' <> 'route' THEN
  RETURN v->'route'='null'::jsonb AND (v#>>'{identity,kind}' <> 'channel-installation' OR v#>>'{identity,channelInstallationRef}'=ch);
 END IF;
 RETURN occ.turn_journal_replay_route_valid(v->'route',i,ch);
END;
$$;
--> statement-breakpoint
CREATE FUNCTION occ.turn_journal_replay_reservation_valid(v jsonb, i text, n text, a text, ch text)
RETURNS boolean LANGUAGE plpgsql IMMUTABLE SET search_path = pg_catalog, occ AS $$
DECLARE subject jsonb; context jsonb;
BEGIN
 IF NOT occ.turn_journal_replay_bounded(v,16384,16,16384)
 OR NOT occ.turn_journal_replay_keys(v,'schemaVersion','scope','channelInstallationRef','creationOperationRef','subject')
 OR (v->'schemaVersion'='1'::jsonb AND v->>'channelInstallationRef'=ch) IS NOT TRUE
 OR NOT occ.turn_journal_replay_id(v->'channelInstallationRef','chi')
 OR NOT occ.turn_journal_replay_reference_valid(v->'creationOperationRef') THEN RETURN false; END IF;
 subject:=v->'subject';
 IF subject->>'kind'='channel-installation' THEN
  RETURN occ.turn_journal_replay_keys(subject,'kind')
   AND occ.turn_journal_replay_keys(v->'scope','installationId')
   AND occ.turn_journal_replay_id(v#>'{scope,installationId}','ins')
   AND (v#>>'{scope,installationId}'=i) IS TRUE;
 END IF;
 IF NOT occ.turn_journal_replay_scope(v->'scope') OR (v->'scope'=jsonb_build_object('installationId',i,'namespaceId',n,'agentId',a)) IS NOT TRUE THEN RETURN false; END IF;
 CASE subject->>'kind'
 WHEN 'route' THEN RETURN occ.turn_journal_replay_keys(subject,'kind','route') AND occ.turn_journal_replay_route_valid(subject->'route',i,ch);
 WHEN 'context' THEN
  context:=subject->'context';
  RETURN occ.turn_journal_replay_keys(subject,'kind','context','creationRef')
   AND occ.turn_journal_replay_keys(context,'installationRef','namespaceRef','agentRef','conversationRef')
   AND (context->>'installationRef'=i AND context->>'namespaceRef'=n AND context->>'agentRef'=a) IS TRUE
   AND occ.turn_journal_replay_manifest_reference_valid(context->'conversationRef')
   AND occ.turn_journal_replay_manifest_reference_valid(subject->'creationRef')
   AND strpos(subject->>'creationRef','://') = 0;
 ELSE RETURN false;
 END CASE;
END;
$$;
--> statement-breakpoint
CREATE FUNCTION occ.turn_journal_replay_activation_pair_valid(pending jsonb, activated jsonb)
RETURNS boolean LANGUAGE plpgsql IMMUTABLE SET search_path = pg_catalog, occ AS $$
DECLARE i text:=pending#>>'{scope,installationId}'; n text:=activated#>>'{scope,namespaceId}'; a text:=activated#>>'{scope,agentId}'; ch text:=pending->>'channelInstallationRef';
BEGIN
 IF NOT occ.turn_journal_replay_reservation_valid(pending,i,n,a,ch)
 OR NOT occ.turn_journal_replay_target_valid(activated,i,n,a,ch)
 OR (pending#>>'{subject,kind}'=activated#>>'{identity,kind}') IS NOT TRUE THEN RETURN false; END IF;
 CASE pending#>>'{subject,kind}'
 WHEN 'route' THEN RETURN pending#>'{subject,route}'=activated->'route';
 WHEN 'context' THEN RETURN pending#>'{subject,context}'=activated#>'{identity,context}' AND pending#>'{subject,creationRef}'=activated#>'{identity,creationRef}';
 ELSE RETURN true;
 END CASE;
END;
$$;
--> statement-breakpoint
CREATE FUNCTION occ.turn_journal_replay_lineage_valid(v jsonb)
RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, occ AS $$
 -- TODO: replace only with the real original-owner full per-target activation,
 -- notBefore, acceptance/pruning and measured-clock representation. A bounded
 -- object or caller-provided reference cannot stand in for that representation.
 SELECT false
$$;
--> statement-breakpoint
CREATE FUNCTION occ.turn_journal_retirement_binding_valid(v jsonb)
RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, occ AS $$
 SELECT occ.turn_journal_replay_keys(v,'schemaVersion','scope','originalTransactionRef','expectedStoppedTransitionRef','expectedLifecycleGeneration','barrierRef','barrierVersion','activationReplayLineageRef','activationReplayLineageVersion','manifest')
 AND (v->'schemaVersion'='1'::jsonb) IS TRUE AND occ.turn_journal_replay_scope(v->'scope')
 AND occ.turn_journal_replay_reference_valid(v->'originalTransactionRef')
 AND (v->>'expectedStoppedTransitionRef' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$') IS TRUE
 AND occ.turn_journal_replay_version(v->'expectedLifecycleGeneration')
 AND occ.turn_journal_replay_reference_valid(v->'barrierRef') AND occ.turn_journal_replay_version(v->'barrierVersion')
 AND occ.turn_journal_replay_reference_valid(v->'activationReplayLineageRef') AND occ.turn_journal_replay_version(v->'activationReplayLineageVersion')
 AND occ.turn_journal_replay_keys(v->'manifest','schemaVersion','scope','purgeOperationRef','requestRef','manifestVersion','manifestDigest')
 AND (v#>'{manifest,schemaVersion}'='1'::jsonb AND v#>'{manifest,scope}'=v->'scope') IS TRUE
 AND occ.turn_journal_replay_manifest_reference_valid(v#>'{manifest,purgeOperationRef}')
 AND occ.turn_journal_replay_manifest_reference_valid(v#>'{manifest,requestRef}')
 AND occ.turn_journal_replay_version(v#>'{manifest,manifestVersion}')
 AND (v#>>'{manifest,manifestDigest}' ~ '^sha256:[0-9a-f]{64}$') IS TRUE
$$;
--> statement-breakpoint
CREATE FUNCTION occ.turn_journal_retirement_store_valid(v jsonb, s jsonb)
RETURNS boolean LANGUAGE plpgsql IMMUTABLE SET search_path = pg_catalog, occ AS $$
DECLARE b jsonb; k text;
BEGIN
 b:=v->'binding';
 IF NOT occ.turn_journal_replay_keys(b,'schemaVersion','scope','logicalStoreRef','bindingRef','bindingVersion')
 OR (b->'schemaVersion'='1'::jsonb AND b->'scope'=s AND v->'schemaVersion'='1'::jsonb) IS NOT TRUE
 OR NOT occ.turn_journal_replay_manifest_reference_valid(b->'logicalStoreRef')
 OR NOT occ.turn_journal_replay_manifest_reference_valid(b->'bindingRef')
 OR NOT occ.turn_journal_replay_version(b->'bindingVersion') THEN RETURN false; END IF;
 CASE v->>'kind'
 WHEN 'kubernetes-volume' THEN
  IF NOT occ.turn_journal_replay_keys(v,'schemaVersion','kind','deleteTarget','binding','role','clusterRef','namespaceName','namespaceUid','claimName','claimUid','volumeName','volumeUid','storageProfileRef','storageProfileDigest','mountPolicyDigest','ownership')
   OR (v->>'deleteTarget'='persistent-volume-claim' AND v->>'role' IN ('gateway-private','workspace') AND v->>'ownership'='exclusive-agent'
    AND jsonb_typeof(v->'namespaceName')='string' AND v->>'namespaceName' ~ '^[a-z0-9]([-a-z0-9]*[a-z0-9])?$' AND length(v->>'namespaceName') <= 63
    AND v->>'storageProfileDigest' ~ '^sha256:[0-9a-f]{64}$' AND v->>'mountPolicyDigest' ~ '^sha256:[0-9a-f]{64}$') IS NOT TRUE THEN RETURN false; END IF;
  FOREACH k IN ARRAY ARRAY['clusterRef','namespaceUid','claimName','claimUid','volumeName','volumeUid','storageProfileRef'] LOOP
   IF NOT occ.turn_journal_replay_manifest_reference_valid(v->k) THEN RETURN false; END IF;
  END LOOP;
 WHEN 'configuration-object' THEN
  IF NOT occ.turn_journal_replay_keys(v,'schemaVersion','kind','binding','role','backendRef','objectRef','objectVersion','contentDigest','ownership')
   OR (v->>'role'='configuration' AND v->>'ownership'='exclusive-agent-materialization' AND v->>'contentDigest' ~ '^sha256:[0-9a-f]{64}$') IS NOT TRUE THEN RETURN false; END IF;
  FOREACH k IN ARRAY ARRAY['backendRef','objectRef','objectVersion'] LOOP
   IF NOT occ.turn_journal_replay_manifest_reference_valid(v->k) THEN RETURN false; END IF;
  END LOOP;
 ELSE RETURN false;
 END CASE;
 RETURN true;
END;
$$;
--> statement-breakpoint
CREATE FUNCTION occ.turn_journal_retirement_manifest_valid(v jsonb)
RETURNS boolean LANGUAGE plpgsql IMMUTABLE SET search_path = pg_catalog, occ AS $$
DECLARE e jsonb; identity jsonb; n integer; hash text;
BEGIN
 IF NOT occ.turn_journal_replay_bounded(v,262144,16,16384)
 OR NOT occ.turn_journal_replay_keys(v,'schemaVersion','scope','purgeOperationRef','requestRef','manifestVersion','retiredIdentities','stores','retention','manifestDigest')
 OR (v->'schemaVersion'='1'::jsonb) IS NOT TRUE OR NOT occ.turn_journal_replay_scope(v->'scope')
 OR NOT occ.turn_journal_replay_manifest_reference_valid(v->'purgeOperationRef') OR NOT occ.turn_journal_replay_manifest_reference_valid(v->'requestRef')
 OR NOT occ.turn_journal_replay_version(v->'manifestVersion')
 OR jsonb_typeof(v->'stores') IS DISTINCT FROM 'array' OR jsonb_typeof(v->'retiredIdentities') IS DISTINCT FROM 'array' THEN RETURN false; END IF;
 IF jsonb_array_length(v->'stores') NOT BETWEEN 1 AND 64 OR jsonb_array_length(v->'retiredIdentities') NOT BETWEEN 1 AND 256 THEN RETURN false; END IF;
 IF v->'retention' IS DISTINCT FROM '{"permanentRetirementBarrier":"retain-installation-lifetime","audit":"separate-retention","providerMessages":"outside-purge","backupsAndSnapshots":"separate-disposal","sharedSecretsAndConfigurations":"excluded","retainedBackingVolumes":"separate-disposal"}'::jsonb THEN RETURN false; END IF;
 FOR e IN SELECT value FROM jsonb_array_elements(v->'stores') LOOP
  IF NOT occ.turn_journal_replay_keys(e,'deletionOperationRef','store') OR NOT occ.turn_journal_replay_manifest_reference_valid(e->'deletionOperationRef')
   OR NOT occ.turn_journal_retirement_store_valid(e->'store',v->'scope') THEN RETURN false; END IF;
 END LOOP;
 SELECT count(DISTINCT e->>'deletionOperationRef') INTO n FROM jsonb_array_elements(v->'stores') e;
 IF n <> jsonb_array_length(v->'stores') THEN RETURN false; END IF;
 SELECT count(DISTINCT e#>>'{store,binding,logicalStoreRef}') INTO n FROM jsonb_array_elements(v->'stores') e;
 IF n <> jsonb_array_length(v->'stores') THEN RETURN false; END IF;
 SELECT count(DISTINCT CASE e#>>'{store,kind}' WHEN 'kubernetes-volume' THEN jsonb_build_array(e#>'{store,clusterRef}',e#>'{store,namespaceUid}',e#>'{store,claimUid}') ELSE jsonb_build_array(e#>'{store,backendRef}',e#>'{store,objectRef}') END)
  INTO n FROM jsonb_array_elements(v->'stores') e;
 IF n <> jsonb_array_length(v->'stores') THEN RETURN false; END IF;
 FOR identity IN SELECT value FROM jsonb_array_elements(v->'retiredIdentities') LOOP
  IF NOT occ.turn_journal_replay_identity_valid(identity,v->'scope') THEN RETURN false; END IF;
 END LOOP;
 SELECT count(DISTINCT CASE e->>'kind' WHEN 'route' THEN 'route:'||(e->>'routeRef') WHEN 'context' THEN 'context:'||(e#>>'{context,conversationRef}') ELSE 'channel:'||(e->>'channelInstallationRef') END)
  INTO n FROM jsonb_array_elements(v->'retiredIdentities') e;
 IF n <> jsonb_array_length(v->'retiredIdentities') THEN RETURN false; END IF;
 hash:='sha256:'||encode(sha256(convert_to('retirement-purge-manifest-v1'||chr(10)||occ.turn_journal_replay_canonical(v-'manifestDigest'),'UTF8')),'hex');
 RETURN (v->>'manifestDigest'=hash) IS TRUE;
END;
$$;
--> statement-breakpoint
CREATE FUNCTION occ.turn_journal_retirement_observation_valid(v jsonb, locator jsonb)
RETURNS boolean LANGUAGE plpgsql IMMUTABLE SET search_path = pg_catalog, occ AS $$
DECLARE instant timestamptz;
BEGIN
 IF NOT occ.turn_journal_replay_bounded(v,262144,16,16384)
 OR NOT occ.turn_journal_replay_keys(v,'schemaVersion','manifest','deletionOperationRef','store','observationRef','observationSequence','observedAt','evidenceRef','outcome')
 OR (v->'schemaVersion'='1'::jsonb AND v->'manifest'=locator AND v->>'outcome' IN ('observed-present','observed-absent','unknown')) IS NOT TRUE
 OR NOT occ.turn_journal_replay_manifest_reference_valid(v->'deletionOperationRef') OR NOT occ.turn_journal_replay_manifest_reference_valid(v->'observationRef')
 OR NOT occ.turn_journal_replay_manifest_reference_valid(v->'evidenceRef') OR NOT occ.turn_journal_replay_version(v->'observationSequence')
 OR NOT occ.turn_journal_retirement_store_valid(v->'store',locator->'scope')
 OR (v->>'observedAt' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$') IS NOT TRUE THEN RETURN false; END IF;
 BEGIN
  instant:=(v->>'observedAt')::timestamptz;
  RETURN to_char(instant AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')=v->>'observedAt';
 EXCEPTION WHEN datetime_field_overflow OR invalid_datetime_format THEN RETURN false;
 END;
END;
$$;
--> statement-breakpoint
CREATE FUNCTION occ.turn_journal_retirement_record_valid(v jsonb)
RETURNS boolean LANGUAGE plpgsql IMMUTABLE SET search_path = pg_catalog, occ AS $$
DECLARE p jsonb; m jsonb; e jsonb; state jsonb; k integer:=0; absent boolean:=true;
BEGIN
 IF NOT occ.turn_journal_replay_bounded(v,786432,24,49152)
 OR NOT occ.turn_journal_replay_keys(v,'schemaVersion','binding','progress','auditIntentRef','durableProgressResponsibilityRef')
 OR (v->'schemaVersion'='1'::jsonb) IS NOT TRUE OR NOT occ.turn_journal_retirement_binding_valid(v->'binding')
 OR NOT occ.turn_journal_replay_reference_valid(v->'auditIntentRef') OR NOT occ.turn_journal_replay_reference_valid(v->'durableProgressResponsibilityRef') THEN RETURN false; END IF;
 p:=v->'progress'; m:=p->'manifest';
 IF NOT occ.turn_journal_replay_bounded(p,262144,16,16384)
 OR NOT occ.turn_journal_replay_keys(p,'schemaVersion','manifest','recordVersion','stores','state')
 OR (p->'schemaVersion'='1'::jsonb) IS NOT TRUE OR NOT occ.turn_journal_replay_version(p->'recordVersion')
 OR NOT occ.turn_journal_retirement_manifest_valid(m)
 OR (v#>'{binding,manifest}'=m-'retiredIdentities'-'stores'-'retention') IS NOT TRUE
 OR jsonb_typeof(p->'stores') IS DISTINCT FROM 'array' THEN RETURN false; END IF;
 IF jsonb_array_length(p->'stores') <> jsonb_array_length(m->'stores') THEN RETURN false; END IF;
 FOR e IN SELECT value FROM jsonb_array_elements(p->'stores') LOOP
  IF NOT occ.turn_journal_replay_keys(e,'entry','state') OR e->'entry' IS DISTINCT FROM m->'stores'->k THEN RETURN false; END IF;
  state:=e->'state';
  IF state->>'kind'='pending' THEN
   IF state IS DISTINCT FROM '{"kind":"pending","observationSequence":0}'::jsonb THEN RETURN false; END IF;
  ELSE
   IF NOT occ.turn_journal_replay_keys(state,'kind','observation')
    OR (state->>'kind'=state#>>'{observation,outcome}' AND state#>'{observation,store}'=e#>'{entry,store}' AND state#>'{observation,deletionOperationRef}'=e#>'{entry,deletionOperationRef}') IS NOT TRUE
    OR NOT occ.turn_journal_retirement_observation_valid(state->'observation',v#>'{binding,manifest}') THEN RETURN false; END IF;
  END IF;
  absent:=absent AND state->>'kind'='observed-absent'; k:=k+1;
 END LOOP;
 RETURN (p->>'state'=CASE WHEN absent THEN 'live-objects-absent' ELSE 'purge-incomplete' END) IS TRUE;
END;
$$;
--> statement-breakpoint
CREATE FUNCTION occ.turn_journal_retirement_receipt_valid(v jsonb)
RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, occ AS $$
 SELECT occ.turn_journal_replay_bounded(v,786432,24,49152)
 AND occ.turn_journal_replay_keys(v,'schemaVersion','binding','originalTransactionRef','observation','recordedAtRecordVersion')
 AND (v->'schemaVersion'='1'::jsonb) IS TRUE
 AND occ.turn_journal_retirement_binding_valid(v->'binding')
 AND occ.turn_journal_replay_reference_valid(v->'originalTransactionRef')
 AND occ.turn_journal_replay_version(v->'recordedAtRecordVersion',2)
 AND occ.turn_journal_retirement_observation_valid(v->'observation',v#>'{binding,manifest}')
$$;
--> statement-breakpoint
CREATE TABLE "occ"."turn_journal_replay_lineage" (
  "installation_id" text NOT NULL,
  "namespace_id" text NOT NULL,
  "agent_id" text NOT NULL,
  "lineage_ref" text NOT NULL,
  "lineage_version" bigint NOT NULL,
  "activation_operation_ref" text NOT NULL,
  "activation_transaction_ref" text NOT NULL,
  "record" jsonb NOT NULL,
  CONSTRAINT "turn_journal_replay_lineage_pk" PRIMARY KEY ("installation_id", "lineage_ref", "lineage_version"),
  CONSTRAINT "turn_journal_replay_lineage_owner_unique" UNIQUE ("installation_id", "namespace_id", "agent_id", "lineage_ref", "lineage_version"),
  CONSTRAINT "turn_journal_replay_lineage_operation_unique" UNIQUE ("installation_id", "activation_operation_ref"),
  CONSTRAINT "turn_journal_replay_lineage_agent_installation" FOREIGN KEY ("installation_id") REFERENCES "occ"."installation" ("id") ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT "turn_journal_replay_lineage_agent_namespace" FOREIGN KEY ("namespace_id") REFERENCES "occ"."namespaces" ("id") ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT "turn_journal_replay_lineage_agent" FOREIGN KEY ("namespace_id", "agent_id") REFERENCES "occ"."agents" ("namespace_id", "id") ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT "turn_journal_replay_lineage_ref" CHECK ("occ"."turn_journal_replay_reference_valid"(to_jsonb("lineage_ref")) IS TRUE),
  CONSTRAINT "turn_journal_replay_lineage_operation" CHECK ("occ"."turn_journal_replay_reference_valid"(to_jsonb("activation_operation_ref")) IS TRUE),
  CONSTRAINT "turn_journal_replay_lineage_transaction" CHECK ("occ"."turn_journal_replay_reference_valid"(to_jsonb("activation_transaction_ref")) IS TRUE),
  CONSTRAINT "turn_journal_replay_lineage_version" CHECK ("lineage_version" BETWEEN 1 AND 9007199254740991),
  CONSTRAINT "turn_journal_replay_lineage_value" CHECK ("occ"."turn_journal_replay_lineage_valid"("record") IS TRUE)
);
--> statement-breakpoint
CREATE TABLE "occ"."turn_journal_replay_heads" (
  "installation_id" text NOT NULL,
  "namespace_id" text,
  "agent_id" text,
  "channel_installation_id" text NOT NULL,
  "target_key" text NOT NULL,
  "target" jsonb NOT NULL,
  "activated_target" jsonb,
  "activated_target_key" text,
  "capacity_slot" bigint NOT NULL,
  "reservation_ref" text NOT NULL,
  "reservation_transaction_ref" text NOT NULL,
  "state" text NOT NULL,
  "record_version" bigint NOT NULL,
  "lineage_ref" text,
  "lineage_version" bigint,
  CONSTRAINT "turn_journal_replay_heads_pk" PRIMARY KEY ("installation_id", "target_key"),
  CONSTRAINT "turn_journal_replay_heads_activation_unique" UNIQUE ("installation_id", "activated_target_key"),
  CONSTRAINT "turn_journal_replay_heads_slot_unique" UNIQUE ("installation_id", "capacity_slot"),
  CONSTRAINT "turn_journal_replay_heads_reservation_unique" UNIQUE ("installation_id", "reservation_ref"),
  CONSTRAINT "turn_journal_replay_heads_owner_unique" UNIQUE ("installation_id", "namespace_id", "agent_id", "target_key"),
  CONSTRAINT "turn_journal_replay_heads_agent_installation" FOREIGN KEY ("installation_id") REFERENCES "occ"."installation" ("id") ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT "turn_journal_replay_heads_agent_namespace" FOREIGN KEY ("namespace_id") REFERENCES "occ"."namespaces" ("id") ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT "turn_journal_replay_heads_agent" FOREIGN KEY ("namespace_id", "agent_id") REFERENCES "occ"."agents" ("namespace_id", "id") ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT "turn_journal_replay_heads_channel" FOREIGN KEY ("installation_id", "channel_installation_id") REFERENCES "occ"."channel_installations" ("installation_id", "id") ON UPDATE RESTRICT ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "turn_journal_replay_heads_lineage" FOREIGN KEY ("installation_id", "namespace_id", "agent_id", "lineage_ref", "lineage_version") REFERENCES "occ"."turn_journal_replay_lineage" ("installation_id", "namespace_id", "agent_id", "lineage_ref", "lineage_version") ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT "turn_journal_replay_heads_capacity" CHECK ("capacity_slot" BETWEEN 1 AND 10000),
  CONSTRAINT "turn_journal_replay_heads_reservation" CHECK ("occ"."turn_journal_replay_reference_valid"(to_jsonb("reservation_ref")) IS TRUE),
  CONSTRAINT "turn_journal_replay_heads_transaction" CHECK ("occ"."turn_journal_replay_reference_valid"(to_jsonb("reservation_transaction_ref")) IS TRUE),
  CONSTRAINT "turn_journal_replay_heads_version" CHECK ("record_version" BETWEEN 1 AND 9007199254740991),
  CONSTRAINT "turn_journal_replay_heads_target" CHECK ("occ"."turn_journal_replay_reservation_valid"("target", "installation_id", "namespace_id", "agent_id", "channel_installation_id") IS TRUE),
  CONSTRAINT "turn_journal_replay_heads_key" CHECK ("target_key" ~ '^[0-9a-f]{64}$' AND "target_key" = "occ".turn_journal_replay_digest("target")),
  CONSTRAINT "turn_journal_replay_heads_reserved_owner" CHECK (("namespace_id" IS NULL) = ("agent_id" IS NULL) AND ("state" <> 'reserved' OR CASE WHEN "target"#>>'{subject,kind}' = 'channel-installation' THEN "namespace_id" IS NULL AND "agent_id" IS NULL ELSE "namespace_id" IS NOT NULL AND "agent_id" IS NOT NULL END)),
  CONSTRAINT "turn_journal_replay_heads_activation_pair" CHECK ("activated_target" IS NULL OR ("occ"."turn_journal_replay_activation_pair_valid"("target", "activated_target") IS TRUE AND "activated_target_key" = "occ".turn_journal_replay_digest("activated_target") AND "activated_target"->'scope' = jsonb_build_object('installationId',"installation_id",'namespaceId',"namespace_id",'agentId',"agent_id"))),
  CONSTRAINT "turn_journal_replay_heads_state" CHECK (("state" = 'reserved' AND "lineage_ref" IS NULL AND "lineage_version" IS NULL AND "activated_target" IS NULL AND "activated_target_key" IS NULL) OR ("state" IN ('active', 'retired') AND "namespace_id" IS NOT NULL AND "agent_id" IS NOT NULL AND "activated_target" IS NOT NULL AND "activated_target_key" IS NOT NULL AND "lineage_ref" IS NOT NULL AND "lineage_version" IS NOT NULL AND "lineage_version" BETWEEN 1 AND 9007199254740991))
);
--> statement-breakpoint
CREATE TABLE "occ"."turn_journal_retirement_publications" (
  "installation_id" text NOT NULL,
  "namespace_id" text NOT NULL,
  "agent_id" text NOT NULL,
  "purge_operation_ref" text NOT NULL,
  "original_transaction_ref" text NOT NULL,
  "barrier_ref" text NOT NULL,
  "barrier_version" bigint NOT NULL,
  "lineage_ref" text NOT NULL,
  "lineage_version" bigint NOT NULL,
  "audit_intent_ref" text NOT NULL,
  "durable_progress_responsibility_ref" text NOT NULL,
  "record_version" bigint NOT NULL,
  "record" jsonb NOT NULL,
  CONSTRAINT "turn_journal_retirement_publications_pk" PRIMARY KEY ("installation_id", "purge_operation_ref"),
  CONSTRAINT "turn_journal_retirement_publications_barrier_unique" UNIQUE ("installation_id", "barrier_ref", "barrier_version"),
  CONSTRAINT "turn_journal_retirement_publications_transaction_unique" UNIQUE ("installation_id", "original_transaction_ref"),
  CONSTRAINT "turn_journal_retirement_publications_owner_unique" UNIQUE ("installation_id", "namespace_id", "agent_id", "purge_operation_ref", "barrier_ref", "barrier_version", "lineage_ref", "lineage_version"),
  CONSTRAINT "turn_journal_retirement_publications_agent_installation" FOREIGN KEY ("installation_id") REFERENCES "occ"."installation" ("id") ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT "turn_journal_retirement_publications_agent_namespace" FOREIGN KEY ("namespace_id") REFERENCES "occ"."namespaces" ("id") ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT "turn_journal_retirement_publications_agent" FOREIGN KEY ("namespace_id", "agent_id") REFERENCES "occ"."agents" ("namespace_id", "id") ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT "turn_journal_retirement_publications_lineage" FOREIGN KEY ("installation_id", "namespace_id", "agent_id", "lineage_ref", "lineage_version") REFERENCES "occ"."turn_journal_replay_lineage" ("installation_id", "namespace_id", "agent_id", "lineage_ref", "lineage_version") ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT "turn_journal_retirement_publications_version" CHECK ("record_version" BETWEEN 1 AND 9007199254740991),
  CONSTRAINT "turn_journal_retirement_publications_barrier_version" CHECK ("barrier_version" BETWEEN 1 AND 9007199254740991),
  CONSTRAINT "turn_journal_retirement_publications_lineage_version" CHECK ("lineage_version" BETWEEN 1 AND 9007199254740991),
  CONSTRAINT "turn_journal_retirement_publications_record" CHECK ("occ"."turn_journal_retirement_record_valid"("record") IS TRUE),
  CONSTRAINT "turn_journal_retirement_publications_projection" CHECK (("record"#>'{binding,scope}' = jsonb_build_object('installationId',"installation_id",'namespaceId',"namespace_id",'agentId',"agent_id") AND "record"#>>'{binding,manifest,purgeOperationRef}' = "purge_operation_ref" AND "record"#>>'{binding,originalTransactionRef}' = "original_transaction_ref" AND "record"#>>'{binding,barrierRef}' = "barrier_ref" AND "record"#>'{binding,barrierVersion}' = to_jsonb("barrier_version") AND "record"#>>'{binding,activationReplayLineageRef}' = "lineage_ref" AND "record"#>'{binding,activationReplayLineageVersion}' = to_jsonb("lineage_version") AND "record"->>'auditIntentRef' = "audit_intent_ref" AND "record"->>'durableProgressResponsibilityRef' = "durable_progress_responsibility_ref" AND "record"#>'{progress,recordVersion}' = to_jsonb("record_version")) IS TRUE)
);
--> statement-breakpoint
CREATE TABLE "occ"."turn_journal_retired_identities" (
  "installation_id" text NOT NULL,
  "namespace_id" text NOT NULL,
  "agent_id" text NOT NULL,
  "purge_operation_ref" text NOT NULL,
  "barrier_ref" text NOT NULL,
  "barrier_version" bigint NOT NULL,
  "lineage_ref" text NOT NULL,
  "lineage_version" bigint NOT NULL,
  "identity_key" text NOT NULL,
  "identity" jsonb NOT NULL,
  "target_key" text NOT NULL,
  CONSTRAINT "turn_journal_retired_identities_pk" PRIMARY KEY ("installation_id", "identity_key"),
  CONSTRAINT "turn_journal_retired_identities_target_unique" UNIQUE ("installation_id", "target_key"),
  CONSTRAINT "turn_journal_retired_identities_head" FOREIGN KEY ("installation_id", "namespace_id", "agent_id", "target_key") REFERENCES "occ"."turn_journal_replay_heads" ("installation_id", "namespace_id", "agent_id", "target_key") ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT "turn_journal_retired_identities_publication" FOREIGN KEY ("installation_id", "namespace_id", "agent_id", "purge_operation_ref", "barrier_ref", "barrier_version", "lineage_ref", "lineage_version") REFERENCES "occ"."turn_journal_retirement_publications" ("installation_id", "namespace_id", "agent_id", "purge_operation_ref", "barrier_ref", "barrier_version", "lineage_ref", "lineage_version") ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT "turn_journal_retired_identities_value" CHECK ("occ"."turn_journal_replay_identity_valid"("identity", jsonb_build_object('installationId',"installation_id",'namespaceId',"namespace_id",'agentId',"agent_id")) IS TRUE),
  CONSTRAINT "turn_journal_retired_identities_key" CHECK ("identity_key" = "occ".turn_journal_replay_digest(jsonb_build_object('scope',jsonb_build_object('installationId',"installation_id",'namespaceId',"namespace_id",'agentId',"agent_id"),'identity',"identity")))
);
--> statement-breakpoint
CREATE TABLE "occ"."turn_journal_retirement_observations" (
  "installation_id" text NOT NULL,
  "namespace_id" text NOT NULL,
  "agent_id" text NOT NULL,
  "purge_operation_ref" text NOT NULL,
  "barrier_ref" text NOT NULL,
  "barrier_version" bigint NOT NULL,
  "lineage_ref" text NOT NULL,
  "lineage_version" bigint NOT NULL,
  "observation_ref" text NOT NULL,
  "deletion_operation_ref" text NOT NULL,
  "observation_sequence" bigint NOT NULL,
  "original_transaction_ref" text NOT NULL,
  "recorded_at_record_version" bigint NOT NULL,
  "receipt" jsonb NOT NULL,
  CONSTRAINT "turn_journal_retirement_observations_pk" PRIMARY KEY ("installation_id", "purge_operation_ref", "observation_ref"),
  CONSTRAINT "turn_journal_retirement_observations_sequence_unique" UNIQUE ("installation_id", "purge_operation_ref", "deletion_operation_ref", "observation_sequence"),
  CONSTRAINT "turn_journal_retirement_observations_version_unique" UNIQUE ("installation_id", "purge_operation_ref", "recorded_at_record_version"),
  CONSTRAINT "turn_journal_retirement_observations_transaction_unique" UNIQUE ("installation_id", "original_transaction_ref"),
  CONSTRAINT "turn_journal_retirement_observations_publication" FOREIGN KEY ("installation_id", "namespace_id", "agent_id", "purge_operation_ref", "barrier_ref", "barrier_version", "lineage_ref", "lineage_version") REFERENCES "occ"."turn_journal_retirement_publications" ("installation_id", "namespace_id", "agent_id", "purge_operation_ref", "barrier_ref", "barrier_version", "lineage_ref", "lineage_version") ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT "turn_journal_retirement_observations_sequence" CHECK ("observation_sequence" BETWEEN 1 AND 9007199254740991),
  CONSTRAINT "turn_journal_retirement_observations_version" CHECK ("recorded_at_record_version" BETWEEN 2 AND 9007199254740991),
  CONSTRAINT "turn_journal_retirement_observations_receipt" CHECK ("occ"."turn_journal_retirement_receipt_valid"("receipt") IS TRUE),
  CONSTRAINT "turn_journal_retirement_observations_projection" CHECK (("receipt"#>'{binding,scope}' = jsonb_build_object('installationId',"installation_id",'namespaceId',"namespace_id",'agentId',"agent_id") AND "receipt"#>>'{binding,manifest,purgeOperationRef}' = "purge_operation_ref" AND "receipt"#>>'{binding,barrierRef}' = "barrier_ref" AND "receipt"#>'{binding,barrierVersion}' = to_jsonb("barrier_version") AND "receipt"#>>'{binding,activationReplayLineageRef}' = "lineage_ref" AND "receipt"#>'{binding,activationReplayLineageVersion}' = to_jsonb("lineage_version") AND "receipt"->>'originalTransactionRef' = "original_transaction_ref" AND "receipt"#>'{recordedAtRecordVersion}' = to_jsonb("recorded_at_record_version") AND "receipt"#>>'{observation,observationRef}' = "observation_ref" AND "receipt"#>>'{observation,deletionOperationRef}' = "deletion_operation_ref" AND "receipt"#>'{observation,observationSequence}' = to_jsonb("observation_sequence")) IS TRUE)
);
--> statement-breakpoint
CREATE FUNCTION occ.turn_journal_replay_immutable()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, occ AS $$
BEGIN
 IF TG_OP='DELETE' OR NEW IS DISTINCT FROM OLD THEN
  RAISE EXCEPTION 'Immutable journal replay record' USING ERRCODE='23514';
 END IF;
 RETURN OLD;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER turn_journal_replay_lineage_immutable BEFORE UPDATE OR DELETE ON occ.turn_journal_replay_lineage FOR EACH ROW EXECUTE FUNCTION occ.turn_journal_replay_immutable();
--> statement-breakpoint
CREATE TRIGGER turn_journal_retired_identities_immutable BEFORE UPDATE OR DELETE ON occ.turn_journal_retired_identities FOR EACH ROW EXECUTE FUNCTION occ.turn_journal_replay_immutable();
--> statement-breakpoint
CREATE TRIGGER turn_journal_retirement_observations_immutable BEFORE UPDATE OR DELETE ON occ.turn_journal_retirement_observations FOR EACH ROW EXECUTE FUNCTION occ.turn_journal_replay_immutable();
--> statement-breakpoint
CREATE FUNCTION occ.turn_journal_replay_head_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, occ AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Permanent replay capacity cannot be released' USING ERRCODE='23514'; END IF;
 IF TG_OP='INSERT' THEN
  IF NEW.state <> 'reserved' OR NEW.record_version <> 1 OR NEW.lineage_ref IS NOT NULL OR NEW.lineage_version IS NOT NULL OR NEW.activated_target IS NOT NULL OR NEW.activated_target_key IS NOT NULL THEN
   RAISE EXCEPTION 'Replay capacity must precede activation' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
 END IF;
 IF NEW IS NOT DISTINCT FROM OLD THEN RETURN OLD; END IF;
 IF (to_jsonb(NEW)-'state'-'record_version'-'lineage_ref'-'lineage_version'-'activated_target'-'activated_target_key'-'namespace_id'-'agent_id') IS DISTINCT FROM
    (to_jsonb(OLD)-'state'-'record_version'-'lineage_ref'-'lineage_version'-'activated_target'-'activated_target_key'-'namespace_id'-'agent_id')
 OR OLD.record_version=9007199254740991 OR NEW.record_version<>OLD.record_version+1
 OR NOT ((OLD.state='reserved' AND NEW.state='active') OR (OLD.state='active' AND NEW.state='retired'))
 OR (OLD.namespace_id IS NOT NULL AND (NEW.namespace_id IS DISTINCT FROM OLD.namespace_id OR NEW.agent_id IS DISTINCT FROM OLD.agent_id))
 OR (OLD.state='active' AND (NEW.lineage_ref IS DISTINCT FROM OLD.lineage_ref OR NEW.lineage_version IS DISTINCT FROM OLD.lineage_version OR NEW.activated_target IS DISTINCT FROM OLD.activated_target OR NEW.activated_target_key IS DISTINCT FROM OLD.activated_target_key)) THEN
  RAISE EXCEPTION 'Invalid replay head transition' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER turn_journal_replay_head_guard BEFORE INSERT OR UPDATE OR DELETE ON occ.turn_journal_replay_heads FOR EACH ROW EXECUTE FUNCTION occ.turn_journal_replay_head_guard();
--> statement-breakpoint
CREATE FUNCTION occ.turn_journal_retirement_publication_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, occ AS $$
DECLARE before_state jsonb; after_state jsonb; old_sequence bigint; changes integer:=0; k integer;
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Permanent retirement cannot be deleted' USING ERRCODE='23514'; END IF;
 IF TG_OP='INSERT' THEN
  -- TODO: publication requires the original stopped-head, authentic lineage,
  -- mandatory audit and durable responsibility composition, which is absent.
  -- Do not replace this with an app-controlled flag or a generic string receipt.
  RAISE EXCEPTION 'Original retirement composition unavailable' USING ERRCODE='55000';
 END IF;
 IF NEW IS NOT DISTINCT FROM OLD THEN RETURN OLD; END IF;
 IF (to_jsonb(NEW)-'record'-'record_version') IS DISTINCT FROM (to_jsonb(OLD)-'record'-'record_version')
 OR (NEW.record-'progress') IS DISTINCT FROM (OLD.record-'progress')
 OR NEW.record#>'{progress,manifest}' IS DISTINCT FROM OLD.record#>'{progress,manifest}'
 OR OLD.record_version=9007199254740991 OR NEW.record_version<>OLD.record_version+1
 OR NOT occ.turn_journal_retirement_record_valid(NEW.record) THEN
  RAISE EXCEPTION 'Invalid retirement progress transition' USING ERRCODE='23514';
 END IF;
 FOR k IN 0..jsonb_array_length(OLD.record#>'{progress,stores}')-1 LOOP
  before_state:=OLD.record#>ARRAY['progress','stores',k::text,'state'];
  after_state:=NEW.record#>ARRAY['progress','stores',k::text,'state'];
  IF before_state=after_state THEN CONTINUE; END IF;
  changes:=changes+1;
  IF before_state->>'kind'='observed-absent' OR after_state->>'kind'='pending' THEN
   RAISE EXCEPTION 'Invalid retirement observation transition' USING ERRCODE='23514';
  END IF;
  old_sequence:=CASE WHEN before_state->>'kind'='pending' THEN 0 ELSE (before_state#>>'{observation,observationSequence}')::bigint END;
  IF old_sequence=9007199254740991 OR (after_state#>>'{observation,observationSequence}')::bigint<>old_sequence+1
  OR (before_state->>'kind'<>'pending' AND (
   before_state#>'{observation,observationRef}'=after_state#>'{observation,observationRef}'
   OR (after_state#>>'{observation,observedAt}')::timestamptz < (before_state#>>'{observation,observedAt}')::timestamptz)) THEN
   RAISE EXCEPTION 'Invalid retirement observation successor' USING ERRCODE='23514';
  END IF;
 END LOOP;
 IF changes<>1 THEN RAISE EXCEPTION 'One observation advances one retirement version' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER turn_journal_retirement_publication_guard BEFORE INSERT OR UPDATE OR DELETE ON occ.turn_journal_retirement_publications FOR EACH ROW EXECUTE FUNCTION occ.turn_journal_retirement_publication_guard();
--> statement-breakpoint
CREATE FUNCTION occ.turn_journal_retirement_graph_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, occ AS $$
DECLARE publication occ.turn_journal_retirement_publications%ROWTYPE;
 item jsonb; store_progress jsonb; receipt occ.turn_journal_retirement_observations%ROWTYPE;
 total bigint; current_sequence bigint; current_observation jsonb;
BEGIN
 -- Deferred NEW can have been superseded by another write in this transaction.
 -- Inspect the final publication and the immutable history that actually remain.
 SELECT * INTO publication FROM occ.turn_journal_retirement_publications
  WHERE installation_id=NEW.installation_id AND purge_operation_ref=NEW.purge_operation_ref;
 IF NOT FOUND THEN RAISE EXCEPTION 'Missing retirement publication' USING ERRCODE='23514'; END IF;
 SELECT count(*) INTO total FROM occ.turn_journal_retired_identities
  WHERE installation_id=publication.installation_id AND purge_operation_ref=publication.purge_operation_ref;
 IF total<>jsonb_array_length(publication.record#>'{progress,manifest,retiredIdentities}') THEN
  RAISE EXCEPTION 'Retirement inventory is incomplete' USING ERRCODE='23514';
 END IF;
 FOR item IN SELECT value FROM jsonb_array_elements(publication.record#>'{progress,manifest,retiredIdentities}') LOOP
  IF NOT EXISTS (
   SELECT 1 FROM occ.turn_journal_retired_identities r JOIN occ.turn_journal_replay_heads h
    ON h.installation_id=r.installation_id AND h.target_key=r.target_key
   WHERE r.installation_id=publication.installation_id AND r.purge_operation_ref=publication.purge_operation_ref
    AND r.identity=item AND r.namespace_id=publication.namespace_id AND r.agent_id=publication.agent_id
    AND h.activated_target->'identity'=r.identity AND h.state='retired'
    AND h.lineage_ref=publication.lineage_ref AND h.lineage_version=publication.lineage_version
  ) THEN RAISE EXCEPTION 'Retirement identity lacks its original reserved head' USING ERRCODE='23514'; END IF;
 END LOOP;
 SELECT count(*) INTO total FROM occ.turn_journal_retirement_observations
  WHERE installation_id=publication.installation_id AND purge_operation_ref=publication.purge_operation_ref;
 IF total<>publication.record_version-1 THEN RAISE EXCEPTION 'Retirement receipt history is incomplete' USING ERRCODE='23514'; END IF;
 IF EXISTS (
  SELECT 1 FROM occ.turn_journal_retirement_observations r
  WHERE r.installation_id=publication.installation_id AND r.purge_operation_ref=publication.purge_operation_ref
   AND (r.recorded_at_record_version>publication.record_version OR r.receipt->'binding'<>publication.record->'binding')
 ) THEN RAISE EXCEPTION 'Retirement receipt ownership mismatch' USING ERRCODE='23514'; END IF;
 FOR store_progress IN SELECT value FROM jsonb_array_elements(publication.record#>'{progress,stores}') LOOP
  current_observation:=store_progress#>'{state,observation}';
  current_sequence:=CASE WHEN store_progress#>>'{state,kind}'='pending' THEN 0 ELSE (current_observation->>'observationSequence')::bigint END;
  SELECT count(*) INTO total FROM occ.turn_journal_retirement_observations r
   WHERE r.installation_id=publication.installation_id AND r.purge_operation_ref=publication.purge_operation_ref
    AND r.deletion_operation_ref=store_progress#>>'{entry,deletionOperationRef}';
  IF total<>current_sequence THEN RAISE EXCEPTION 'Store receipt sequence is incomplete' USING ERRCODE='23514'; END IF;
  FOR receipt IN SELECT * FROM occ.turn_journal_retirement_observations r
   WHERE r.installation_id=publication.installation_id AND r.purge_operation_ref=publication.purge_operation_ref
    AND r.deletion_operation_ref=store_progress#>>'{entry,deletionOperationRef}' LOOP
   IF receipt.receipt#>'{observation,store}' IS DISTINCT FROM store_progress#>'{entry,store}'
   OR receipt.observation_sequence>current_sequence
   OR (receipt.observation_sequence=current_sequence AND receipt.receipt->'observation' IS DISTINCT FROM current_observation)
   OR (receipt.observation_sequence<current_sequence AND receipt.receipt#>>'{observation,outcome}'='observed-absent') THEN
    RAISE EXCEPTION 'Store receipt correspondence mismatch' USING ERRCODE='23514';
   END IF;
   IF receipt.observation_sequence>1 AND NOT EXISTS (
    SELECT 1 FROM occ.turn_journal_retirement_observations prior
    WHERE prior.installation_id=receipt.installation_id AND prior.purge_operation_ref=receipt.purge_operation_ref
     AND prior.deletion_operation_ref=receipt.deletion_operation_ref AND prior.observation_sequence=receipt.observation_sequence-1
     AND prior.recorded_at_record_version<receipt.recorded_at_record_version
     AND (prior.receipt#>>'{observation,observedAt}')::timestamptz <= (receipt.receipt#>>'{observation,observedAt}')::timestamptz
     AND prior.receipt#>>'{observation,outcome}'<>'observed-absent'
   ) THEN RAISE EXCEPTION 'Store receipt predecessor mismatch' USING ERRCODE='23514'; END IF;
  END LOOP;
 END LOOP;
 -- Every receipt must name a store in this original immutable manifest.
 IF EXISTS (
  SELECT 1 FROM occ.turn_journal_retirement_observations r
  WHERE r.installation_id=publication.installation_id AND r.purge_operation_ref=publication.purge_operation_ref
   AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(publication.record#>'{progress,manifest,stores}') e
    WHERE e->>'deletionOperationRef'=r.deletion_operation_ref AND e->'store'=r.receipt#>'{observation,store}')
 ) THEN RAISE EXCEPTION 'Receipt is outside the original manifest' USING ERRCODE='23514'; END IF;
 RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER turn_journal_retirement_publication_complete AFTER INSERT OR UPDATE ON occ.turn_journal_retirement_publications DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION occ.turn_journal_retirement_graph_guard();
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER turn_journal_retirement_identity_complete AFTER INSERT ON occ.turn_journal_retired_identities DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION occ.turn_journal_retirement_graph_guard();
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER turn_journal_retirement_observation_complete AFTER INSERT ON occ.turn_journal_retirement_observations DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION occ.turn_journal_retirement_graph_guard();
--> statement-breakpoint
CREATE FUNCTION occ.turn_journal_retirement_transition_complete()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, occ AS $$
DECLARE k integer; changed_observation jsonb;
BEGIN
 IF NEW IS NOT DISTINCT FROM OLD THEN RETURN NULL; END IF;
 -- This guard deliberately retains this UPDATE's NEW snapshot: the immutable
 -- first receipt must identify the exact version at which its observation won,
 -- even if another store advances the publication before deferred checks run.
 FOR k IN 0..jsonb_array_length(NEW.record#>'{progress,stores}')-1 LOOP
  IF OLD.record#>ARRAY['progress','stores',k::text,'state'] IS NOT DISTINCT FROM
     NEW.record#>ARRAY['progress','stores',k::text,'state'] THEN CONTINUE; END IF;
  changed_observation:=NEW.record#>ARRAY['progress','stores',k::text,'state','observation'];
  IF NOT EXISTS (
   SELECT 1 FROM occ.turn_journal_retirement_observations r
   WHERE r.installation_id=NEW.installation_id AND r.purge_operation_ref=NEW.purge_operation_ref
    AND r.recorded_at_record_version=NEW.record_version
    AND r.receipt->'binding'=NEW.record->'binding'
    AND r.receipt->'observation'=changed_observation
  ) THEN RAISE EXCEPTION 'Observation first receipt version mismatch' USING ERRCODE='23514'; END IF;
 END LOOP;
 RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER turn_journal_retirement_transition_complete AFTER UPDATE ON occ.turn_journal_retirement_publications DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION occ.turn_journal_retirement_transition_complete();
--> statement-breakpoint
CREATE FUNCTION occ.turn_journal_replay_head_complete()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, occ AS $$
DECLARE head occ.turn_journal_replay_heads%ROWTYPE;
BEGIN
 SELECT * INTO head FROM occ.turn_journal_replay_heads WHERE installation_id=NEW.installation_id AND target_key=NEW.target_key;
 IF NOT FOUND THEN RAISE EXCEPTION 'Permanent replay reservation is missing' USING ERRCODE='23514'; END IF;
 IF (head.state='retired') IS DISTINCT FROM EXISTS (
  SELECT 1 FROM occ.turn_journal_retired_identities r WHERE r.installation_id=head.installation_id AND r.target_key=head.target_key
   AND r.namespace_id=head.namespace_id AND r.agent_id=head.agent_id AND r.identity=head.activated_target->'identity'
   AND r.lineage_ref=head.lineage_ref AND r.lineage_version=head.lineage_version
 ) THEN RAISE EXCEPTION 'Replay head retirement is incomplete' USING ERRCODE='23514'; END IF;
 RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER turn_journal_replay_head_complete AFTER INSERT OR UPDATE ON occ.turn_journal_replay_heads DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION occ.turn_journal_replay_head_complete();
--> statement-breakpoint
-- No activation or retirement writer grant exists while original producer composition is absent.
-- No row-level bypass or SQL function issues authority. Keep trigger functions
-- unavailable for arbitrary explicit calls, as in the existing journal migration.
REVOKE ALL ON occ.turn_journal_replay_lineage, occ.turn_journal_replay_heads, occ.turn_journal_retired_identities, occ.turn_journal_retirement_publications, occ.turn_journal_retirement_observations FROM PUBLIC, occ_app;
--> statement-breakpoint
GRANT SELECT ON occ.turn_journal_replay_lineage, occ.turn_journal_replay_heads, occ.turn_journal_retired_identities, occ.turn_journal_retirement_publications, occ.turn_journal_retirement_observations TO occ_app;
--> statement-breakpoint
GRANT INSERT ON occ.turn_journal_replay_heads TO occ_app;
--> statement-breakpoint
-- Column-limited UPDATE permits SELECT FOR UPDATE; guarded state/owner/lineage columns remain unavailable.
GRANT UPDATE (record_version) ON occ.turn_journal_replay_heads TO occ_app;
--> statement-breakpoint
REVOKE ALL ON FUNCTION occ.turn_journal_replay_keys(jsonb, text[]) FROM PUBLIC, occ_app;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION occ.turn_journal_replay_keys(jsonb, text[]) TO occ_app;
--> statement-breakpoint
REVOKE ALL ON FUNCTION occ.turn_journal_replay_reference_valid(jsonb) FROM PUBLIC, occ_app;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION occ.turn_journal_replay_reference_valid(jsonb) TO occ_app;
--> statement-breakpoint
REVOKE ALL ON FUNCTION occ.turn_journal_replay_manifest_reference_valid(jsonb) FROM PUBLIC, occ_app;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION occ.turn_journal_replay_manifest_reference_valid(jsonb) TO occ_app;
--> statement-breakpoint
REVOKE ALL ON FUNCTION occ.turn_journal_replay_version(jsonb, bigint) FROM PUBLIC, occ_app;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION occ.turn_journal_replay_version(jsonb, bigint) TO occ_app;
--> statement-breakpoint
REVOKE ALL ON FUNCTION occ.turn_journal_replay_id(jsonb, text) FROM PUBLIC, occ_app;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION occ.turn_journal_replay_id(jsonb, text) TO occ_app;
--> statement-breakpoint
REVOKE ALL ON FUNCTION occ.turn_journal_replay_scope(jsonb) FROM PUBLIC, occ_app;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION occ.turn_journal_replay_scope(jsonb) TO occ_app;
--> statement-breakpoint
REVOKE ALL ON FUNCTION occ.turn_journal_replay_canonical(jsonb) FROM PUBLIC, occ_app;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION occ.turn_journal_replay_canonical(jsonb) TO occ_app;
--> statement-breakpoint
REVOKE ALL ON FUNCTION occ.turn_journal_replay_digest(jsonb) FROM PUBLIC, occ_app;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION occ.turn_journal_replay_digest(jsonb) TO occ_app;
--> statement-breakpoint
REVOKE ALL ON FUNCTION occ.turn_journal_replay_bounded(jsonb, integer, integer, integer) FROM PUBLIC, occ_app;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION occ.turn_journal_replay_bounded(jsonb, integer, integer, integer) TO occ_app;
--> statement-breakpoint
REVOKE ALL ON FUNCTION occ.turn_journal_replay_identity_valid(jsonb, jsonb) FROM PUBLIC, occ_app;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION occ.turn_journal_replay_identity_valid(jsonb, jsonb) TO occ_app;
--> statement-breakpoint
REVOKE ALL ON FUNCTION occ.turn_journal_replay_native_ref(jsonb) FROM PUBLIC, occ_app;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION occ.turn_journal_replay_native_ref(jsonb) TO occ_app;
--> statement-breakpoint
REVOKE ALL ON FUNCTION occ.turn_journal_replay_route_valid(jsonb, text, text) FROM PUBLIC, occ_app;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION occ.turn_journal_replay_route_valid(jsonb, text, text) TO occ_app;
--> statement-breakpoint
REVOKE ALL ON FUNCTION occ.turn_journal_replay_target_valid(jsonb, text, text, text, text) FROM PUBLIC, occ_app;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION occ.turn_journal_replay_target_valid(jsonb, text, text, text, text) TO occ_app;
--> statement-breakpoint
REVOKE ALL ON FUNCTION occ.turn_journal_replay_reservation_valid(jsonb, text, text, text, text) FROM PUBLIC, occ_app;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION occ.turn_journal_replay_reservation_valid(jsonb, text, text, text, text) TO occ_app;
--> statement-breakpoint
REVOKE ALL ON FUNCTION occ.turn_journal_replay_activation_pair_valid(jsonb, jsonb) FROM PUBLIC, occ_app;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION occ.turn_journal_replay_activation_pair_valid(jsonb, jsonb) TO occ_app;
--> statement-breakpoint
REVOKE ALL ON FUNCTION occ.turn_journal_replay_lineage_valid(jsonb) FROM PUBLIC, occ_app;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION occ.turn_journal_replay_lineage_valid(jsonb) TO occ_app;
--> statement-breakpoint
REVOKE ALL ON FUNCTION occ.turn_journal_retirement_binding_valid(jsonb) FROM PUBLIC, occ_app;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION occ.turn_journal_retirement_binding_valid(jsonb) TO occ_app;
--> statement-breakpoint
REVOKE ALL ON FUNCTION occ.turn_journal_retirement_store_valid(jsonb, jsonb) FROM PUBLIC, occ_app;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION occ.turn_journal_retirement_store_valid(jsonb, jsonb) TO occ_app;
--> statement-breakpoint
REVOKE ALL ON FUNCTION occ.turn_journal_retirement_manifest_valid(jsonb) FROM PUBLIC, occ_app;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION occ.turn_journal_retirement_manifest_valid(jsonb) TO occ_app;
--> statement-breakpoint
REVOKE ALL ON FUNCTION occ.turn_journal_retirement_observation_valid(jsonb, jsonb) FROM PUBLIC, occ_app;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION occ.turn_journal_retirement_observation_valid(jsonb, jsonb) TO occ_app;
--> statement-breakpoint
REVOKE ALL ON FUNCTION occ.turn_journal_retirement_record_valid(jsonb) FROM PUBLIC, occ_app;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION occ.turn_journal_retirement_record_valid(jsonb) TO occ_app;
--> statement-breakpoint
REVOKE ALL ON FUNCTION occ.turn_journal_retirement_receipt_valid(jsonb) FROM PUBLIC, occ_app;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION occ.turn_journal_retirement_receipt_valid(jsonb) TO occ_app;
--> statement-breakpoint
REVOKE ALL ON FUNCTION occ.turn_journal_replay_immutable() FROM PUBLIC, occ_app;
--> statement-breakpoint
REVOKE ALL ON FUNCTION occ.turn_journal_replay_head_guard() FROM PUBLIC, occ_app;
--> statement-breakpoint
REVOKE ALL ON FUNCTION occ.turn_journal_retirement_publication_guard() FROM PUBLIC, occ_app;
--> statement-breakpoint
REVOKE ALL ON FUNCTION occ.turn_journal_retirement_graph_guard() FROM PUBLIC, occ_app;
--> statement-breakpoint
REVOKE ALL ON FUNCTION occ.turn_journal_retirement_transition_complete() FROM PUBLIC, occ_app;
--> statement-breakpoint
REVOKE ALL ON FUNCTION occ.turn_journal_replay_head_complete() FROM PUBLIC, occ_app;
--> statement-breakpoint
