-- Bindings retain the descriptor exposed by the API. Projected columns enforce
-- ownership, signing-Secret references, and generation compare-and-set updates.
CREATE TABLE occ.repository_bindings (
  id text PRIMARY KEY,
  namespace_id text NOT NULL REFERENCES occ.namespaces(id),
  owner_installation_id text NOT NULL REFERENCES occ.installation(id),
  key_secret_id text NOT NULL,
  generation bigint NOT NULL,
  descriptor jsonb NOT NULL,
  CONSTRAINT repository_bindings_id_format CHECK (
    id ~ '^rb_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  ),
  CONSTRAINT repository_bindings_generation_valid CHECK (
    generation BETWEEN 1 AND 9007199254740991
  ),
  CONSTRAINT repository_bindings_secret_owner
    FOREIGN KEY (namespace_id, key_secret_id)
    REFERENCES occ.secrets(namespace_id, id)
);
--> statement-breakpoint
-- Supports both the Secret reference lookup and the referencing side of its FK.
CREATE INDEX repository_bindings_key_secret_idx
  ON occ.repository_bindings(namespace_id, key_secret_id);
--> statement-breakpoint
CREATE FUNCTION occ.validate_repository_binding() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  binding jsonb := NEW.descriptor;
  repository_id jsonb;
  github_id jsonb;
  seen_repository_ids jsonb := '[]';
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.id <> OLD.id
        OR NEW.namespace_id <> OLD.namespace_id
        OR NEW.owner_installation_id <> OLD.owner_installation_id
        OR NEW.generation <> OLD.generation + 1
        OR binding->'createdAt' IS DISTINCT FROM OLD.descriptor->'createdAt' THEN
      RAISE EXCEPTION 'binding identity is immutable; generation must advance once'
        USING ERRCODE = '23514';
    END IF;
  ELSIF NEW.generation <> 1 THEN
    RAISE EXCEPTION 'binding initial generation must be one'
      USING ERRCODE = '23514';
  END IF;

  IF NOT COALESCE(
    jsonb_typeof(binding) = 'object'
    AND binding ?& ARRAY[
      'id', 'namespaceId', 'appId', 'installationId', 'repositoryIds',
      'keySecretRef', 'generation', 'state', 'createdAt'
    ]
    AND binding - ARRAY[
      'id', 'namespaceId', 'appId', 'installationId', 'repositoryIds',
      'keySecretRef', 'generation', 'state', 'createdAt'
    ] = '{}'::jsonb
    AND binding->>'id' = NEW.id
    AND binding->>'namespaceId' = NEW.namespace_id
    AND binding->'generation' = to_jsonb(NEW.generation)
    AND binding->>'state' = 'unverified'
    AND jsonb_typeof(binding->'createdAt') = 'string'
    AND binding->>'createdAt' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[.][0-9]{3}Z$'
    AND binding->'keySecretRef' = jsonb_build_object(
      'kind', 'secret',
      'namespaceId', NEW.namespace_id,
      'id', NEW.key_secret_id
    )
    AND jsonb_typeof(binding->'repositoryIds') = 'array',
    false
  ) THEN
    RAISE EXCEPTION 'invalid unverified binding descriptor' USING ERRCODE = '23514';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM occ.namespaces
    WHERE id = NEW.namespace_id
      AND deleted_at IS NULL
      AND status IN ('provisioning', 'ready')
  ) THEN
    RAISE EXCEPTION 'binding namespace unavailable' USING ERRCODE = '23514';
  END IF;

  IF jsonb_array_length(binding->'repositoryIds') NOT BETWEEN 1 AND 32 THEN
    RAISE EXCEPTION 'invalid repository count' USING ERRCODE = '23514';
  END IF;
  FOR repository_id IN
    SELECT value FROM jsonb_array_elements(binding->'repositoryIds')
  LOOP
    IF jsonb_typeof(repository_id) <> 'number'
        OR repository_id::text::numeric NOT BETWEEN 1 AND 9007199254740991
        OR mod(repository_id::text::numeric, 1) <> 0
        OR seen_repository_ids @> jsonb_build_array(repository_id) THEN
      RAISE EXCEPTION 'invalid or duplicate repository id' USING ERRCODE = '23514';
    END IF;
    seen_repository_ids := seen_repository_ids || jsonb_build_array(repository_id);
  END LOOP;

  FOR github_id IN
    SELECT value
    FROM jsonb_array_elements(jsonb_build_array(binding->'appId', binding->'installationId'))
  LOOP
    IF jsonb_typeof(github_id) <> 'number'
        OR github_id::text::numeric NOT BETWEEN 1 AND 9007199254740991
        OR mod(github_id::text::numeric, 1) <> 0 THEN
      RAISE EXCEPTION 'invalid App/installation id' USING ERRCODE = '23514';
    END IF;
  END LOOP;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER repository_binding_valid
  BEFORE INSERT OR UPDATE ON occ.repository_bindings
  FOR EACH ROW EXECUTE FUNCTION occ.validate_repository_binding();
--> statement-breakpoint
CREATE TRIGGER repository_binding_no_delete
  BEFORE DELETE ON occ.repository_bindings
  FOR EACH ROW EXECUTE FUNCTION occ.reject_row_mutation();
--> statement-breakpoint
ALTER TABLE occ.agents
  ADD COLUMN repository_access jsonb NOT NULL
    DEFAULT '{"schemaVersion":1,"repositories":[]}';
--> statement-breakpoint
-- This CHECK validates only the draft value; binding membership is checked by
-- the write trigger below so the immutable function never reads mutable tables.
CREATE FUNCTION occ.repository_access_valid(selection jsonb, selected_namespace_id text)
RETURNS boolean
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  entry jsonb;
  checkout_ref text;
  ref_component text;
  selected_pairs text[] := '{}';
  selected_pair text;
BEGIN
  IF NOT COALESCE(
    jsonb_typeof(selection) = 'object'
    AND selection ?& ARRAY['schemaVersion', 'repositories']
    AND selection - ARRAY['schemaVersion', 'repositories'] = '{}'::jsonb
    AND selection->'schemaVersion' = '1'::jsonb
    AND jsonb_typeof(selection->'repositories') = 'array',
    false
  ) THEN
    RETURN false;
  END IF;
  IF jsonb_array_length(selection->'repositories') > 8 THEN
    RETURN false;
  END IF;

  FOR entry IN SELECT value FROM jsonb_array_elements(selection->'repositories') LOOP
    IF NOT COALESCE(
      jsonb_typeof(entry) = 'object'
      AND entry ?& ARRAY['bindingRef', 'repositoryId', 'checkoutRef', 'readProfile', 'publication']
      AND entry - ARRAY[
        'bindingRef', 'repositoryId', 'checkoutRef', 'readProfile', 'publication'
      ] = '{}'::jsonb
      AND entry->>'readProfile' = 'checkout'
      AND entry->'publication' = '{"mode":"disabled"}'::jsonb
      AND jsonb_typeof(entry->'bindingRef') = 'object'
      AND (entry->'bindingRef') - ARRAY['kind', 'id', 'namespaceId'] = '{}'::jsonb
      AND entry #>> '{bindingRef,kind}' = 'repository_binding'
      AND entry #>> '{bindingRef,namespaceId}' = selected_namespace_id
      AND entry #>> '{bindingRef,id}' ~ '^rb_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      AND jsonb_typeof(entry->'repositoryId') = 'number'
      AND jsonb_typeof(entry->'checkoutRef') = 'string',
      false
    ) THEN
      RETURN false;
    END IF;
    IF (entry->>'repositoryId')::numeric NOT BETWEEN 1 AND 9007199254740991
        OR mod((entry->>'repositoryId')::numeric, 1) <> 0 THEN
      RETURN false;
    END IF;

    -- Canonicalize numeric IDs so JSON numbers such as 790 and 790.0 collide.
    selected_pair := (entry #>> '{bindingRef,id}') || '/'
      || (entry->>'repositoryId')::numeric::bigint::text;
    IF selected_pair = ANY(selected_pairs) THEN
      RETURN false;
    END IF;
    selected_pairs := array_append(selected_pairs, selected_pair);

    checkout_ref := entry->>'checkoutRef';
    IF length(checkout_ref) > 256 THEN
      RETURN false;
    END IF;
    -- Match the JavaScript codec's UTF-16 bound for supplementary characters.
    IF (
      SELECT sum(CASE WHEN ascii(character) > 65535 THEN 2 ELSE 1 END)
      FROM regexp_split_to_table(checkout_ref, '') AS character
    ) > 256 THEN
      RETURN false;
    END IF;
    IF checkout_ref !~ '^[0-9a-fA-F]{40}$' THEN
      IF checkout_ref !~ '^refs/(heads|tags)/.+'
          OR checkout_ref ~ '[[:cntrl:] ~^:?*\[\\]'
          OR checkout_ref ~ ('[' || chr(128) || '-' || chr(159) || ']')
          OR position('..' IN checkout_ref) > 0
          OR position('@{' IN checkout_ref) > 0
          OR right(checkout_ref, 1) = '.' THEN
        RETURN false;
      END IF;
      FOREACH ref_component IN ARRAY string_to_array(checkout_ref, '/') LOOP
        IF ref_component = ''
            OR left(ref_component, 1) = '.'
            OR right(ref_component, 5) = '.lock' THEN
          RETURN false;
        END IF;
      END LOOP;
    END IF;
  END LOOP;
  RETURN true;
END;
$$;
--> statement-breakpoint
ALTER TABLE occ.agents
  ADD CONSTRAINT agents_repository_access_valid
    CHECK (occ.repository_access_valid(repository_access, namespace_id));
--> statement-breakpoint
CREATE FUNCTION occ.validate_agent_repository_references() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  entry jsonb;
BEGIN
  FOR entry IN SELECT value FROM jsonb_array_elements(NEW.repository_access->'repositories') LOOP
    IF NOT EXISTS (
      SELECT 1
      FROM occ.repository_bindings
      WHERE namespace_id = NEW.namespace_id
        AND id = entry #>> '{bindingRef,id}'
        AND descriptor->'repositoryIds' @> jsonb_build_array(entry->'repositoryId')
    ) THEN
      RAISE EXCEPTION 'repository binding reference unavailable' USING ERRCODE = '23503';
    END IF;
  END LOOP;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER agent_repository_references
  BEFORE INSERT OR UPDATE OF repository_access ON occ.agents
  FOR EACH ROW EXECUTE FUNCTION occ.validate_agent_repository_references();
--> statement-breakpoint
GRANT SELECT, INSERT ON occ.repository_bindings TO occ_app;
--> statement-breakpoint
GRANT UPDATE (key_secret_id, generation, descriptor) ON occ.repository_bindings TO occ_app;
--> statement-breakpoint
GRANT UPDATE (repository_access) ON occ.agents TO occ_app;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION occ.repository_access_valid(jsonb, text) TO occ_app;
--> statement-breakpoint
ALTER TABLE occ.iam_restrictions
  DROP CONSTRAINT iam_restrictions_resource_kind_valid,
  ADD CONSTRAINT iam_restrictions_resource_kind_valid CHECK (
    resource_kind IN (
      'installation', 'namespace', 'configuration', 'service_account', 'secret',
      'agent', 'agent_revision', 'repository_binding'
    )
  );
--> statement-breakpoint
ALTER TABLE occ.iam_access_bindings
  ADD CONSTRAINT iam_bindings_repository_namespace CHECK (
    resource_kind IS DISTINCT FROM 'repository_binding' OR namespace_id IS NOT NULL
  );
--> statement-breakpoint
ALTER TABLE occ.iam_restrictions
  ADD CONSTRAINT iam_restrictions_repository_namespace CHECK (
    resource_kind <> 'repository_binding' OR namespace_id IS NOT NULL
  );
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
    RETURN EXISTS (
      SELECT 1 FROM occ.repository_bindings
      WHERE namespace_id = checked_namespace_id AND id = checked_resource_id
    );
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
