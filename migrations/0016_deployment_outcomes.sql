CREATE FUNCTION occ.controller_work_plugin_errors_are_valid(errors jsonb) RETURNS boolean
LANGUAGE sql
IMMUTABLE
STRICT
AS $$
  SELECT jsonb_typeof(errors) = 'array'
    AND jsonb_array_length(errors) <= 32
    AND NOT EXISTS (
      SELECT 1
      FROM jsonb_array_elements(errors) AS entry
      WHERE jsonb_typeof(entry) <> 'object'
         OR entry->>'code' <> 'PLUGIN_INSTALL_FAILED'
         OR entry->>'message' <> 'Plugin installation failed.'
         OR NOT (entry ?& ARRAY['driverId', 'pluginId', 'code', 'message'])
         OR (entry - 'driverId' - 'pluginId' - 'code' - 'message') <> '{}'::jsonb
         OR jsonb_typeof(entry->'driverId') <> 'string'
         OR jsonb_typeof(entry->'pluginId') <> 'string'
         OR jsonb_typeof(entry->'code') <> 'string'
         OR jsonb_typeof(entry->'message') <> 'string'
         OR char_length(entry->>'driverId') NOT BETWEEN 1 AND 512
         OR btrim(entry->>'driverId') <> entry->>'driverId'
         OR entry->>'driverId' ~ '[[:cntrl:]]'
         OR char_length(entry->>'pluginId') NOT BETWEEN 1 AND 512
         OR btrim(entry->>'pluginId') <> entry->>'pluginId'
         OR entry->>'pluginId' ~ '[[:cntrl:]]'
    )
    AND (
      SELECT count(*)
      FROM (
        SELECT DISTINCT entry->>'driverId', entry->>'pluginId'
        FROM jsonb_array_elements(errors) AS entry
      ) AS unique_errors
    ) = jsonb_array_length(errors);
$$;
--> statement-breakpoint
ALTER TABLE occ.controller_work
  ADD COLUMN terminal_reason_code text,
  ADD COLUMN plugin_errors jsonb NOT NULL DEFAULT '[]'::jsonb;
--> statement-breakpoint
UPDATE occ.controller_work
SET terminal_reason_code = CASE
  WHEN state = 'succeeded' THEN 'RECONCILE_SUCCEEDED'
  WHEN state = 'failed_permanent' THEN 'UNKNOWN_FAILURE'
  ELSE NULL
END
WHERE state IN ('succeeded', 'failed_permanent');
--> statement-breakpoint
ALTER TABLE occ.controller_work
  ADD CONSTRAINT controller_work_terminal_reason_code_valid CHECK (
    terminal_reason_code IS NULL OR terminal_reason_code ~ '^[A-Z0-9_]{1,64}$'
  ),
  ADD CONSTRAINT controller_work_plugin_errors_valid CHECK (
    occ.controller_work_plugin_errors_are_valid(plugin_errors)
  );
--> statement-breakpoint
ALTER TABLE occ.controller_work
  DROP CONSTRAINT controller_work_completion_state,
  ADD CONSTRAINT controller_work_completion_state CHECK (
    (
      state IN ('succeeded', 'failed_permanent')
      AND completed_at IS NOT NULL
      AND terminal_reason_code IS NOT NULL
    )
    OR (
      state NOT IN ('succeeded', 'failed_permanent')
      AND completed_at IS NULL
      AND terminal_reason_code IS NULL
    )
  );
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION occ.controller_work_plugin_errors_are_valid(jsonb) TO occ_app;
--> statement-breakpoint
GRANT UPDATE (terminal_reason_code, plugin_errors) ON occ.controller_work TO occ_app;
