CREATE FUNCTION occ.plugin_identity_text_is_valid(value text) RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$
  SELECT value IS NOT NULL
    AND char_length(value) BETWEEN 1 AND 512
    AND value = btrim(value)
    AND value !~ '[[:cntrl:]]';
$$;
--> statement-breakpoint
CREATE FUNCTION occ.plugin_identities_are_valid(plugins jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$
  SELECT
    jsonb_typeof(plugins) = 'array'
    AND jsonb_array_length(plugins) <= 32
    AND NOT EXISTS (
      SELECT 1
      FROM jsonb_array_elements(plugins) AS entry(plugin)
      WHERE jsonb_typeof(plugin) IS DISTINCT FROM 'object'
        OR NOT (plugin ?& ARRAY['driverId', 'pluginId'])
        OR plugin - 'driverId' - 'pluginId' <> '{}'::jsonb
        OR jsonb_typeof(plugin->'driverId') IS DISTINCT FROM 'string'
        OR jsonb_typeof(plugin->'pluginId') IS DISTINCT FROM 'string'
        OR NOT occ.plugin_identity_text_is_valid(plugin->>'driverId')
        OR NOT occ.plugin_identity_text_is_valid(plugin->>'pluginId')
    )
    AND (
      SELECT count(*)
      FROM jsonb_array_elements(plugins)
    ) = (
      SELECT count(DISTINCT jsonb_build_array(plugin->>'driverId', plugin->>'pluginId'))
      FROM jsonb_array_elements(plugins) AS entry(plugin)
    );
$$;
--> statement-breakpoint
CREATE FUNCTION occ.plugin_snapshots_are_valid(plugins jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$
  SELECT
    jsonb_typeof(plugins) = 'array'
    AND jsonb_array_length(plugins) <= 32
    AND NOT EXISTS (
      SELECT 1
      FROM jsonb_array_elements(plugins) AS entry(plugin)
      WHERE jsonb_typeof(plugin) IS DISTINCT FROM 'object'
        OR NOT (plugin ?& ARRAY[
          'driverId', 'pluginId', 'remoteMarketplaceName', 'remotePluginId',
          'version', 'catalogCodexVersion'
        ])
        OR plugin - 'driverId' - 'pluginId' - 'remoteMarketplaceName'
          - 'remotePluginId' - 'version' - 'catalogCodexVersion' <> '{}'::jsonb
        OR jsonb_typeof(plugin->'driverId') IS DISTINCT FROM 'string'
        OR jsonb_typeof(plugin->'pluginId') IS DISTINCT FROM 'string'
        OR jsonb_typeof(plugin->'remoteMarketplaceName') IS DISTINCT FROM 'string'
        OR jsonb_typeof(plugin->'remotePluginId') IS DISTINCT FROM 'string'
        OR jsonb_typeof(plugin->'catalogCodexVersion') IS DISTINCT FROM 'string'
        OR NOT occ.plugin_identity_text_is_valid(plugin->>'driverId')
        OR NOT occ.plugin_identity_text_is_valid(plugin->>'pluginId')
        OR NOT occ.plugin_identity_text_is_valid(plugin->>'remoteMarketplaceName')
        OR NOT occ.plugin_identity_text_is_valid(plugin->>'remotePluginId')
        OR NOT occ.plugin_identity_text_is_valid(plugin->>'catalogCodexVersion')
        OR (
          jsonb_typeof(plugin->'version') IS DISTINCT FROM 'null'
          AND (
            jsonb_typeof(plugin->'version') IS DISTINCT FROM 'string'
            OR NOT occ.plugin_identity_text_is_valid(plugin->>'version')
          )
        )
    )
    AND (
      SELECT count(*)
      FROM jsonb_array_elements(plugins)
    ) = (
      SELECT count(DISTINCT jsonb_build_array(plugin->>'driverId', plugin->>'pluginId'))
      FROM jsonb_array_elements(plugins) AS entry(plugin)
    );
$$;
--> statement-breakpoint
ALTER TABLE occ.agents ADD COLUMN selected_plugins jsonb NOT NULL DEFAULT '[]'::jsonb;
--> statement-breakpoint
ALTER TABLE occ.agents ADD CONSTRAINT agents_selected_plugins_valid CHECK (
  occ.plugin_identities_are_valid(selected_plugins)
);
--> statement-breakpoint
ALTER TABLE occ.agent_revisions
  ADD COLUMN selected_plugins jsonb NOT NULL DEFAULT '[]'::jsonb;
--> statement-breakpoint
ALTER TABLE occ.agent_revisions
  ADD CONSTRAINT agent_revisions_selected_plugins_valid CHECK (
    occ.plugin_snapshots_are_valid(selected_plugins)
  );
