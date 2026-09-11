-- Agent plugin selections remain draft data, not admitted runtime material.
ALTER TABLE occ.agents
  ADD COLUMN plugins jsonb,
  ADD CONSTRAINT agents_plugins_object
    CHECK (plugins IS NULL OR jsonb_typeof(plugins) = 'object');
--> statement-breakpoint
GRANT UPDATE (plugins) ON occ.agents TO occ_app;
