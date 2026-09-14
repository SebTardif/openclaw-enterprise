CREATE TABLE occ.repository_bindings (
 id text PRIMARY KEY CHECK (id ~ '^rb_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
 namespace_id text NOT NULL REFERENCES occ.namespaces(id),
 owner_installation_id text NOT NULL REFERENCES occ.installation(id),
 key_secret_id text NOT NULL,
 generation bigint NOT NULL CHECK (generation BETWEEN 1 AND 9007199254740991),
 descriptor jsonb NOT NULL,
 UNIQUE(namespace_id,id),
 FOREIGN KEY(namespace_id,key_secret_id) REFERENCES occ.secrets(namespace_id,id)
);
--> statement-breakpoint
CREATE FUNCTION occ.validate_repository_binding() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v jsonb := NEW.descriptor; repo jsonb; seen jsonb := '[]';
BEGIN
 IF TG_OP = 'UPDATE' THEN
  IF NEW.id <> OLD.id
      OR NEW.namespace_id <> OLD.namespace_id
      OR NEW.owner_installation_id <> OLD.owner_installation_id
      OR NEW.generation <> OLD.generation+1
      OR v->'createdAt' IS DISTINCT FROM OLD.descriptor->'createdAt' THEN
    RAISE EXCEPTION 'binding identity is immutable; generation must advance once' USING ERRCODE='23514';
  END IF;
 ELSIF NEW.generation <> 1 THEN RAISE EXCEPTION 'binding initial generation must be one' USING ERRCODE='23514'; END IF;
 IF NOT COALESCE(jsonb_typeof(v)='object'
     AND v ?& ARRAY['id','namespaceId','appId','installationId','repositoryIds','keySecretRef','generation','state','createdAt']
     AND v - 'id' - 'namespaceId' - 'appId' - 'installationId' - 'repositoryIds' - 'keySecretRef' - 'generation' - 'state' - 'createdAt' = '{}'::jsonb
     AND v->>'id'=NEW.id
     AND v->>'namespaceId'=NEW.namespace_id
     AND v->'generation'=to_jsonb(NEW.generation)
     AND v->>'state'='unverified'
     AND jsonb_typeof(v->'createdAt')='string'
     AND v->>'createdAt' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[.][0-9]{3}Z$'
     AND v->'keySecretRef'=jsonb_build_object('kind','secret','namespaceId',NEW.namespace_id,'id',NEW.key_secret_id)
     AND jsonb_typeof(v->'repositoryIds')='array',false) THEN
   RAISE EXCEPTION 'invalid unverified binding descriptor' USING ERRCODE='23514';
 END IF;
 IF NOT EXISTS(SELECT 1 FROM occ.namespaces WHERE id=NEW.namespace_id
     AND deleted_at IS NULL
     AND status IN ('provisioning','ready')) THEN
   RAISE EXCEPTION 'binding namespace unavailable' USING ERRCODE='23514';
 END IF;
 IF jsonb_array_length(v->'repositoryIds') NOT BETWEEN 1 AND 32 THEN RAISE EXCEPTION 'invalid repository count' USING ERRCODE='23514'; END IF;
 FOR repo IN SELECT value FROM jsonb_array_elements(v->'repositoryIds') LOOP
  IF jsonb_typeof(repo)<>'number'
      OR (repo::text)::numeric NOT BETWEEN 1
      AND 9007199254740991
      OR mod((repo::text)::numeric,1)<>0
      OR seen @> jsonb_build_array(repo) THEN
    RAISE EXCEPTION 'invalid or duplicate repository id' USING ERRCODE='23514';
  END IF;
  seen := seen || jsonb_build_array(repo);
 END LOOP;
 FOR repo IN SELECT value FROM jsonb_array_elements(jsonb_build_array(v->'appId',v->'installationId')) LOOP
  IF jsonb_typeof(repo)<>'number'
      OR (repo::text)::numeric NOT BETWEEN 1
      AND 9007199254740991
      OR mod((repo::text)::numeric,1)<>0 THEN
    RAISE EXCEPTION 'invalid App/installation id' USING ERRCODE='23514';
  END IF;
 END LOOP;
 RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER repository_binding_valid BEFORE INSERT OR UPDATE ON occ.repository_bindings FOR EACH ROW EXECUTE FUNCTION occ.validate_repository_binding();
--> statement-breakpoint
CREATE TRIGGER repository_binding_no_delete BEFORE DELETE ON occ.repository_bindings FOR EACH ROW EXECUTE FUNCTION occ.reject_row_mutation();
--> statement-breakpoint
ALTER TABLE occ.agents ADD COLUMN repository_access jsonb NOT NULL DEFAULT '{"schemaVersion":1,"repositories":[]}';
--> statement-breakpoint
CREATE FUNCTION occ.repository_access_valid(v jsonb, ns text) RETURNS boolean LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE e jsonb; ref text; component text; seen text[] := '{}'; pair text;
BEGIN
 IF NOT COALESCE(jsonb_typeof(v)='object'
     AND v ?& ARRAY['schemaVersion','repositories']
     AND v - 'schemaVersion' - 'repositories' = '{}'::jsonb
     AND v->'schemaVersion'='1'::jsonb
     AND jsonb_typeof(v->'repositories')='array',false) THEN
   RETURN false;
 END IF;
 IF jsonb_array_length(v->'repositories')>8 THEN RETURN false; END IF;
 FOR e IN SELECT value FROM jsonb_array_elements(v->'repositories') LOOP
  IF NOT COALESCE(jsonb_typeof(e)='object'
      AND e ?& ARRAY['bindingRef','repositoryId','checkoutRef','readProfile','publication']
      AND e - 'bindingRef' - 'repositoryId' - 'checkoutRef' - 'readProfile' - 'publication'='{}'::jsonb
      AND e->>'readProfile'='checkout'
      AND e->'publication'='{"mode":"disabled"}'::jsonb
      AND jsonb_typeof(e->'bindingRef')='object'
      AND (e->'bindingRef') - 'kind' - 'id' - 'namespaceId'='{}'::jsonb
      AND e#>>'{bindingRef,kind}'='repository_binding'
      AND e#>>'{bindingRef,namespaceId}'=ns
      AND e#>>'{bindingRef,id}' ~ '^rb_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      AND jsonb_typeof(e->'repositoryId')='number'
      AND jsonb_typeof(e->'checkoutRef')='string',false) THEN
    RETURN false;
  END IF;
  IF (e->>'repositoryId')::numeric NOT BETWEEN 1 AND 9007199254740991 OR mod((e->>'repositoryId')::numeric,1)<>0 THEN RETURN false; END IF;
  pair := (e#>>'{bindingRef,id}') || '/' || ((e->>'repositoryId')::numeric::bigint)::text;
  IF pair=ANY(seen) THEN RETURN false; END IF;
  seen := array_append(seen,pair);
  ref := e->>'checkoutRef';
  IF length(ref)>256 THEN RETURN false; END IF;
  -- Match the JavaScript codec's UTF-16 code-unit bound, including supplementary characters.
  IF (SELECT sum(CASE WHEN ascii(character)>65535 THEN 2 ELSE 1 END)
      FROM regexp_split_to_table(ref, '') AS character)>256 THEN RETURN false; END IF;
  IF ref !~ '^[0-9a-fA-F]{40}$' THEN
   IF ref !~ '^refs/(heads|tags)/.+' OR ref ~ '[[:cntrl:] ~^:?*\[\\]' OR ref ~ ('[' || chr(128) || '-' || chr(159) || ']')
       OR position('..' in ref)>0 OR position('@{' in ref)>0 OR right(ref,1)='.' THEN RETURN false; END IF;
   FOREACH component IN ARRAY string_to_array(ref,'/') LOOP
    IF component='' OR left(component,1)='.' OR right(component,5)='.lock' THEN RETURN false; END IF;
   END LOOP;
  END IF;
 END LOOP;
 RETURN true;
END $$;
--> statement-breakpoint
ALTER TABLE occ.agents ADD CONSTRAINT agents_repository_access_valid CHECK (occ.repository_access_valid(repository_access,namespace_id));
--> statement-breakpoint
CREATE FUNCTION occ.validate_agent_repository_references() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE e jsonb;
BEGIN
 FOR e IN SELECT value FROM jsonb_array_elements(NEW.repository_access->'repositories') LOOP
  IF NOT EXISTS(SELECT 1 FROM occ.repository_bindings WHERE namespace_id=NEW.namespace_id
      AND id=e#>>'{bindingRef,id}'
      AND descriptor->'repositoryIds' @> jsonb_build_array(e->'repositoryId')) THEN
    RAISE EXCEPTION 'repository binding reference unavailable' USING ERRCODE='23503';
  END IF;
 END LOOP;
 RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER agent_repository_references BEFORE INSERT OR UPDATE OF repository_access ON occ.agents FOR EACH ROW EXECUTE FUNCTION occ.validate_agent_repository_references();
--> statement-breakpoint
GRANT SELECT,INSERT ON occ.repository_bindings TO occ_app;
--> statement-breakpoint
GRANT UPDATE (key_secret_id,generation,descriptor) ON occ.repository_bindings TO occ_app;
--> statement-breakpoint
GRANT UPDATE (repository_access) ON occ.agents TO occ_app;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION occ.repository_access_valid(jsonb,text) TO occ_app;
--> statement-breakpoint
ALTER TABLE occ.iam_restrictions DROP CONSTRAINT iam_restrictions_resource_kind_valid;
--> statement-breakpoint
ALTER TABLE occ.iam_restrictions ADD CONSTRAINT iam_restrictions_resource_kind_valid CHECK (resource_kind IN ('installation','namespace','configuration','service_account','secret','agent','agent_revision','repository_binding'));
--> statement-breakpoint
ALTER TABLE occ.iam_access_bindings ADD CONSTRAINT iam_bindings_repository_namespace CHECK (resource_kind IS DISTINCT FROM 'repository_binding' OR namespace_id IS NOT NULL);
--> statement-breakpoint
ALTER TABLE occ.iam_restrictions ADD CONSTRAINT iam_restrictions_repository_namespace CHECK (resource_kind <> 'repository_binding' OR namespace_id IS NOT NULL);
--> statement-breakpoint
CREATE OR REPLACE FUNCTION occ.resource_belongs_to_namespace(
  checked_namespace_id text,
  checked_resource_kind text,
  checked_resource_id text
) RETURNS boolean
LANGUAGE plpgsql STABLE AS $$
BEGIN
  IF checked_namespace_id IS NULL THEN
    RETURN true;
  END IF;
  IF checked_resource_kind = 'installation' THEN
    RETURN false;
  END IF;
  IF checked_resource_id IS NULL THEN
    RETURN true;
  END IF;
  IF checked_resource_kind = 'namespace' THEN
    RETURN checked_resource_id = checked_namespace_id;
  ELSIF checked_resource_kind = 'configuration' THEN
    RETURN EXISTS (
      SELECT 1 FROM occ.configurations
      WHERE namespace_id = checked_namespace_id AND id = checked_resource_id
    );
  ELSIF checked_resource_kind = 'service_account' THEN
    RETURN checked_resource_id = checked_namespace_id OR EXISTS (
      SELECT 1 FROM occ.service_accounts
      WHERE namespace_id = checked_namespace_id AND id = checked_resource_id
    );
  ELSIF checked_resource_kind = 'secret' THEN
    RETURN EXISTS (
      SELECT 1 FROM occ.secrets
      WHERE namespace_id = checked_namespace_id AND id = checked_resource_id
    );
  ELSIF checked_resource_kind = 'repository_binding' THEN
    RETURN EXISTS (SELECT 1 FROM occ.repository_bindings WHERE namespace_id = checked_namespace_id AND id = checked_resource_id);
  ELSIF checked_resource_kind = 'agent' THEN
    RETURN EXISTS (
      SELECT 1 FROM occ.agents
      WHERE namespace_id = checked_namespace_id AND id = checked_resource_id
    );
  ELSIF checked_resource_kind = 'agent_revision' THEN
    RETURN EXISTS (
      SELECT 1 FROM occ.agent_revisions
      WHERE namespace_id = checked_namespace_id AND id = checked_resource_id
    );
  END IF;
  RETURN false;
END;
$$;
