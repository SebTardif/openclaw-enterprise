-- Explicit semantic registration belongs to its existing authoritative grant.
-- Existing rows remain unmapped; Role names and generic permissions classify no one.
CREATE FUNCTION occ.channel_administration_mapping_valid(value jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE SET search_path = pg_catalog AS $$
DECLARE field text; reference text; version_value numeric;
BEGIN
  IF jsonb_typeof(value) IS DISTINCT FROM 'object' THEN RETURN false; END IF;
  IF (SELECT array_agg(key ORDER BY key) FROM jsonb_object_keys(value) AS key)
     IS DISTINCT FROM ARRAY['installationId','roleId','schemaVersion','semanticClass','status','version']
  THEN RETURN false; END IF;
  IF value->'schemaVersion' IS DISTINCT FROM '1'::jsonb
     OR value->>'semanticClass' IS DISTINCT FROM 'installation-administrator'
     OR jsonb_typeof(value->'status') IS DISTINCT FROM 'string'
     OR value->>'status' NOT IN ('enabled','disabled')
     OR jsonb_typeof(value->'version') IS DISTINCT FROM 'number'
  THEN RETURN false; END IF;
  version_value := (value->>'version')::numeric;
  IF version_value < 1 OR version_value > 9007199254740991
     OR version_value <> trunc(version_value) THEN RETURN false; END IF;
  FOREACH field IN ARRAY ARRAY['installationId','roleId'] LOOP
    IF jsonb_typeof(value->field) IS DISTINCT FROM 'string' THEN RETURN false; END IF;
    reference := value->>field;
    -- The closed decoder accepts bounded UTF-8 opaque IAM identifiers, not labels.
    -- U+0000 is already prohibited by PostgreSQL jsonb; reject other C0/C1 controls.
    IF octet_length(reference) NOT BETWEEN 1 AND 1024
       OR reference ~ U&'[\0001-\001F\007F-\009F]'
       OR btrim(reference, U&' \0009\000A\000B\000C\000D\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF') = ''
    THEN RETURN false; END IF;
  END LOOP;
  RETURN true;
END;
$$;
--> statement-breakpoint
ALTER TABLE occ.iam_access_bindings ADD COLUMN channel_administration jsonb;
--> statement-breakpoint
ALTER TABLE occ.iam_access_bindings ADD CONSTRAINT iam_access_bindings_channel_administration_valid
CHECK (channel_administration IS NULL OR occ.channel_administration_mapping_valid(channel_administration));
--> statement-breakpoint
CREATE FUNCTION occ.validate_channel_administration_binding() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, occ AS $$
DECLARE previous jsonb; current_mapping jsonb;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.channel_administration IS NOT NULL THEN
      RAISE EXCEPTION 'mapped channel administration bindings must retain their identity' USING ERRCODE='23514';
    END IF;
    RETURN OLD;
  END IF;
  current_mapping := NEW.channel_administration;
  IF TG_OP = 'UPDATE' THEN previous := OLD.channel_administration; END IF;
  IF previous IS NOT NULL THEN
    IF current_mapping IS NULL
       OR ROW(NEW.id,NEW.namespace_id,NEW.identity_subject_id,NEW.group_subject_id,NEW.role_id,NEW.resource_kind,NEW.resource_id)
          IS DISTINCT FROM ROW(OLD.id,OLD.namespace_id,OLD.identity_subject_id,OLD.group_subject_id,OLD.role_id,OLD.resource_kind,OLD.resource_id)
    THEN RAISE EXCEPTION 'mapped channel administration binding identity is immutable' USING ERRCODE='23514'; END IF;
  END IF;
  IF current_mapping IS NULL THEN RETURN NEW; END IF;
  IF NOT occ.channel_administration_mapping_valid(current_mapping) THEN
    RAISE EXCEPTION 'channel administration mapping has an invalid closed shape' USING ERRCODE='23514';
  END IF;
  IF NEW.namespace_id IS NOT NULL
     OR current_mapping->>'roleId' IS DISTINCT FROM NEW.role_id
     OR NOT EXISTS(SELECT 1 FROM occ.installation WHERE id=current_mapping->>'installationId')
     OR NOT EXISTS(SELECT 1 FROM occ.iam_roles WHERE id=NEW.role_id AND namespace_id IS NULL)
     OR (NEW.resource_kind IS NOT NULL AND
         (NEW.resource_kind <> 'installation' OR NEW.resource_id IS DISTINCT FROM current_mapping->>'installationId'))
  THEN RAISE EXCEPTION 'channel administration mapping has an invalid grant owner' USING ERRCODE='23514'; END IF;
  IF previous IS NULL THEN
    IF (current_mapping->>'version')::numeric <> 1 THEN
      RAISE EXCEPTION 'channel administration registration must start at version one' USING ERRCODE='23514';
    END IF;
  ELSIF current_mapping IS DISTINCT FROM previous THEN
    IF (current_mapping - 'status' - 'version') IS DISTINCT FROM (previous - 'status' - 'version')
       OR current_mapping->>'status' IS NOT DISTINCT FROM previous->>'status'
       OR (current_mapping->>'version')::numeric <> (previous->>'version')::numeric + 1
    THEN RAISE EXCEPTION 'channel administration status requires its next version' USING ERRCODE='23514'; END IF;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER iam_channel_administration_binding_is_valid
BEFORE INSERT OR UPDATE OR DELETE ON occ.iam_access_bindings
FOR EACH ROW EXECUTE FUNCTION occ.validate_channel_administration_binding();
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION occ.channel_administration_mapping_valid(jsonb) TO occ_app;
