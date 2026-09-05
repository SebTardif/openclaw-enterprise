CREATE TABLE occ.channel_installations (
  id text PRIMARY KEY,
  installation_id text NOT NULL REFERENCES occ.installation(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  version bigint NOT NULL,
  status text NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  created_by text COLLATE "C" NOT NULL,
  updated_by text COLLATE "C" NOT NULL,
  platform text NOT NULL,
  provider_tenant_ref text COLLATE "C" NOT NULL,
  recipient_app_ref text COLLATE "C" NOT NULL,
  CONSTRAINT channel_installations_id_format CHECK (id ~ '^chi_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
  CONSTRAINT channel_installations_version_valid CHECK (version BETWEEN 1 AND 9007199254740991),
  CONSTRAINT channel_installations_status_valid CHECK (status IN ('enabled', 'disabled')),
  CONSTRAINT channel_installations_timestamps_valid CHECK (isfinite(created_at) AND isfinite(updated_at) AND updated_at >= created_at),
  CONSTRAINT channel_installations_created_by_valid CHECK (octet_length(created_by) BETWEEN 1 AND 1024 AND created_by COLLATE "C" !~ ('[' || chr(1) || '-' || chr(31) || chr(127) || '-' || chr(159) || ']')),
  CONSTRAINT channel_installations_updated_by_valid CHECK (octet_length(updated_by) BETWEEN 1 AND 1024 AND updated_by COLLATE "C" !~ ('[' || chr(1) || '-' || chr(31) || chr(127) || '-' || chr(159) || ']')),
  CONSTRAINT channel_installations_provider_tenant_ref_valid CHECK (octet_length(provider_tenant_ref) BETWEEN 1 AND 1024 AND provider_tenant_ref COLLATE "C" !~ ('[' || chr(1) || '-' || chr(31) || chr(127) || '-' || chr(159) || ']')),
  CONSTRAINT channel_installations_recipient_app_ref_valid CHECK (octet_length(recipient_app_ref) BETWEEN 1 AND 1024 AND recipient_app_ref COLLATE "C" !~ ('[' || chr(1) || '-' || chr(31) || chr(127) || '-' || chr(159) || ']')),
  CONSTRAINT channel_installations_owner_id_unique UNIQUE (installation_id, id),
  CONSTRAINT channel_installations_retained_tuple_unique UNIQUE (platform, provider_tenant_ref, recipient_app_ref),
  CONSTRAINT channel_installations_platform_valid CHECK (platform IN ('slack', 'msteams'))
);
--> statement-breakpoint
CREATE TABLE occ.channel_human_bindings (
  id text PRIMARY KEY,
  installation_id text NOT NULL REFERENCES occ.installation(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  version bigint NOT NULL,
  status text NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  created_by text COLLATE "C" NOT NULL,
  updated_by text COLLATE "C" NOT NULL,
  channel_installation_id text NOT NULL,
  provider_subject_ref text COLLATE "C" NOT NULL,
  iam_driver_id text COLLATE "C" NOT NULL,
  principal_id text COLLATE "C" NOT NULL,
  principal_issuer text COLLATE "C" NOT NULL,
  principal_subject text COLLATE "C" NOT NULL,
  CONSTRAINT channel_human_bindings_id_format CHECK (id ~ '^chh_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
  CONSTRAINT channel_human_bindings_version_valid CHECK (version BETWEEN 1 AND 9007199254740991),
  CONSTRAINT channel_human_bindings_status_valid CHECK (status IN ('enabled', 'disabled')),
  CONSTRAINT channel_human_bindings_timestamps_valid CHECK (isfinite(created_at) AND isfinite(updated_at) AND updated_at >= created_at),
  CONSTRAINT channel_human_bindings_created_by_valid CHECK (octet_length(created_by) BETWEEN 1 AND 1024 AND created_by COLLATE "C" !~ ('[' || chr(1) || '-' || chr(31) || chr(127) || '-' || chr(159) || ']')),
  CONSTRAINT channel_human_bindings_updated_by_valid CHECK (octet_length(updated_by) BETWEEN 1 AND 1024 AND updated_by COLLATE "C" !~ ('[' || chr(1) || '-' || chr(31) || chr(127) || '-' || chr(159) || ']')),
  CONSTRAINT channel_human_bindings_provider_subject_ref_valid CHECK (octet_length(provider_subject_ref) BETWEEN 1 AND 1024 AND provider_subject_ref COLLATE "C" !~ ('[' || chr(1) || '-' || chr(31) || chr(127) || '-' || chr(159) || ']')),
  CONSTRAINT channel_human_bindings_iam_driver_id_valid CHECK (octet_length(iam_driver_id) BETWEEN 1 AND 1024 AND iam_driver_id COLLATE "C" !~ ('[' || chr(1) || '-' || chr(31) || chr(127) || '-' || chr(159) || ']')),
  CONSTRAINT channel_human_bindings_principal_id_valid CHECK (octet_length(principal_id) BETWEEN 1 AND 1024 AND principal_id COLLATE "C" !~ ('[' || chr(1) || '-' || chr(31) || chr(127) || '-' || chr(159) || ']')),
  CONSTRAINT channel_human_bindings_principal_issuer_valid CHECK (octet_length(principal_issuer) BETWEEN 1 AND 1024 AND principal_issuer COLLATE "C" !~ ('[' || chr(1) || '-' || chr(31) || chr(127) || '-' || chr(159) || ']')),
  CONSTRAINT channel_human_bindings_principal_subject_valid CHECK (octet_length(principal_subject) BETWEEN 1 AND 1024 AND principal_subject COLLATE "C" !~ ('[' || chr(1) || '-' || chr(31) || chr(127) || '-' || chr(159) || ']')),
  CONSTRAINT channel_human_bindings_parent_owner FOREIGN KEY (installation_id, channel_installation_id) REFERENCES occ.channel_installations(installation_id, id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT channel_human_bindings_retained_tuple_unique UNIQUE (channel_installation_id, provider_subject_ref)
);
--> statement-breakpoint
CREATE TABLE occ.channel_agent_bindings (
  id text PRIMARY KEY,
  installation_id text NOT NULL REFERENCES occ.installation(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  version bigint NOT NULL,
  status text NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  created_by text COLLATE "C" NOT NULL,
  updated_by text COLLATE "C" NOT NULL,
  channel_installation_id text NOT NULL,
  channel_ref text COLLATE "C" NOT NULL,
  scope_kind text NOT NULL,
  namespace_id text NOT NULL,
  agent_id text NOT NULL,
  CONSTRAINT channel_agent_bindings_id_format CHECK (id ~ '^cha_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
  CONSTRAINT channel_agent_bindings_version_valid CHECK (version BETWEEN 1 AND 9007199254740991),
  CONSTRAINT channel_agent_bindings_status_valid CHECK (status IN ('enabled', 'disabled')),
  CONSTRAINT channel_agent_bindings_timestamps_valid CHECK (isfinite(created_at) AND isfinite(updated_at) AND updated_at >= created_at),
  CONSTRAINT channel_agent_bindings_created_by_valid CHECK (octet_length(created_by) BETWEEN 1 AND 1024 AND created_by COLLATE "C" !~ ('[' || chr(1) || '-' || chr(31) || chr(127) || '-' || chr(159) || ']')),
  CONSTRAINT channel_agent_bindings_updated_by_valid CHECK (octet_length(updated_by) BETWEEN 1 AND 1024 AND updated_by COLLATE "C" !~ ('[' || chr(1) || '-' || chr(31) || chr(127) || '-' || chr(159) || ']')),
  CONSTRAINT channel_agent_bindings_channel_ref_valid CHECK (octet_length(channel_ref) BETWEEN 1 AND 1024 AND channel_ref COLLATE "C" !~ ('[' || chr(1) || '-' || chr(31) || chr(127) || '-' || chr(159) || ']')),
  CONSTRAINT channel_agent_bindings_parent_owner FOREIGN KEY (installation_id, channel_installation_id) REFERENCES occ.channel_installations(installation_id, id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT channel_agent_bindings_retained_tuple_unique UNIQUE (channel_installation_id, channel_ref),
  CONSTRAINT channel_agent_bindings_agent_owner FOREIGN KEY (namespace_id, agent_id) REFERENCES occ.agents(namespace_id, id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT channel_agent_bindings_scope_kind_valid CHECK (scope_kind IN ('slack-private-channel', 'msteams-standard-channel'))
);
--> statement-breakpoint
CREATE FUNCTION occ.require_channel_binding_status_transition() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.version <> 1 OR NEW.status <> 'enabled'
      OR NEW.updated_at IS DISTINCT FROM NEW.created_at
      OR NEW.updated_by IS DISTINCT FROM NEW.created_by THEN
      RAISE EXCEPTION 'channel binding must begin enabled at version one with creation attribution'
        USING ERRCODE = '23514';
    END IF;
  ELSIF NEW.status = OLD.status OR NEW.version <> OLD.version + 1 THEN
    RAISE EXCEPTION 'channel binding status change must advance version exactly once'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE FUNCTION occ.require_enabled_channel_binding_parent() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  parent_status text;
  parent_platform text;
BEGIN
  -- Serialize child creation/enable with parent disable using the same parent row.
  SELECT status, platform INTO parent_status, parent_platform
    FROM occ.channel_installations
    WHERE installation_id = NEW.installation_id AND id = NEW.channel_installation_id
    FOR UPDATE;
  IF parent_status IS NULL THEN
    RAISE EXCEPTION 'channel binding parent does not exist' USING ERRCODE = '23503';
  END IF;
  IF NEW.status = 'enabled' AND parent_status <> 'enabled' THEN
    RAISE EXCEPTION 'channel binding requires an enabled parent' USING ERRCODE = '23514';
  END IF;
  IF TG_TABLE_NAME = 'channel_agent_bindings' THEN
    IF (parent_platform = 'slack' AND NEW.scope_kind <> 'slack-private-channel')
      OR (parent_platform = 'msteams' AND NEW.scope_kind <> 'msteams-standard-channel') THEN
      RAISE EXCEPTION 'channel scope does not match parent platform' USING ERRCODE = '23514';
    END IF;
    IF NEW.status = 'enabled' THEN
      PERFORM 1 FROM occ.namespaces n
        JOIN occ.agents a ON a.namespace_id = n.id
        WHERE n.id = NEW.namespace_id AND a.id = NEW.agent_id
          AND n.status = 'ready' AND n.deleted_at IS NULL
        FOR SHARE OF n, a;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'channel route requires an available Agent owner' USING ERRCODE = '23514';
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER channel_installations_identity_is_immutable
BEFORE UPDATE OF id, installation_id, created_at, created_by, platform, provider_tenant_ref, recipient_app_ref OR DELETE ON occ.channel_installations
FOR EACH ROW EXECUTE FUNCTION occ.reject_row_mutation();
--> statement-breakpoint
CREATE TRIGGER channel_installations_status_transition
BEFORE INSERT OR UPDATE ON occ.channel_installations
FOR EACH ROW EXECUTE FUNCTION occ.require_channel_binding_status_transition();
--> statement-breakpoint
CREATE TRIGGER channel_human_bindings_identity_is_immutable
BEFORE UPDATE OF id, installation_id, created_at, created_by, channel_installation_id, provider_subject_ref, iam_driver_id, principal_id, principal_issuer, principal_subject OR DELETE ON occ.channel_human_bindings
FOR EACH ROW EXECUTE FUNCTION occ.reject_row_mutation();
--> statement-breakpoint
CREATE TRIGGER channel_human_bindings_status_transition
BEFORE INSERT OR UPDATE ON occ.channel_human_bindings
FOR EACH ROW EXECUTE FUNCTION occ.require_channel_binding_status_transition();
--> statement-breakpoint
CREATE TRIGGER channel_human_bindings_parent_state
BEFORE INSERT OR UPDATE ON occ.channel_human_bindings
FOR EACH ROW EXECUTE FUNCTION occ.require_enabled_channel_binding_parent();
--> statement-breakpoint
CREATE TRIGGER channel_agent_bindings_identity_is_immutable
BEFORE UPDATE OF id, installation_id, created_at, created_by, channel_installation_id, channel_ref, scope_kind, namespace_id, agent_id OR DELETE ON occ.channel_agent_bindings
FOR EACH ROW EXECUTE FUNCTION occ.reject_row_mutation();
--> statement-breakpoint
CREATE TRIGGER channel_agent_bindings_status_transition
BEFORE INSERT OR UPDATE ON occ.channel_agent_bindings
FOR EACH ROW EXECUTE FUNCTION occ.require_channel_binding_status_transition();
--> statement-breakpoint
CREATE TRIGGER channel_agent_bindings_parent_state
BEFORE INSERT OR UPDATE ON occ.channel_agent_bindings
FOR EACH ROW EXECUTE FUNCTION occ.require_enabled_channel_binding_parent();
--> statement-breakpoint
REVOKE ALL ON occ.channel_installations, occ.channel_human_bindings,
  occ.channel_agent_bindings FROM PUBLIC, occ_app;
--> statement-breakpoint
REVOKE ALL ON FUNCTION occ.require_channel_binding_status_transition(),
  occ.require_enabled_channel_binding_parent() FROM PUBLIC, occ_app;
--> statement-breakpoint
GRANT SELECT, INSERT ON occ.channel_installations, occ.channel_human_bindings,
  occ.channel_agent_bindings TO occ_app;
--> statement-breakpoint
GRANT UPDATE (status, version, updated_at, updated_by) ON occ.channel_installations TO occ_app;
--> statement-breakpoint
GRANT UPDATE (status, version, updated_at, updated_by) ON occ.channel_human_bindings TO occ_app;
--> statement-breakpoint
GRANT UPDATE (status, version, updated_at, updated_by) ON occ.channel_agent_bindings TO occ_app;
