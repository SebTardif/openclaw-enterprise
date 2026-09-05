CREATE TABLE occ.sign_in_quota_slots (
  slot integer PRIMARY KEY,
  next_at_ms bigint NOT NULL,
  CONSTRAINT sign_in_quota_slot_bounded CHECK (slot >= 0 AND slot < 20480),
  CONSTRAINT sign_in_quota_timestamp_valid CHECK (next_at_ms BETWEEN 0 AND 9007199254740991)
);
--> statement-breakpoint
REVOKE ALL ON occ.sign_in_quota_slots FROM PUBLIC, occ_app;
--> statement-breakpoint
GRANT SELECT, INSERT ON occ.sign_in_quota_slots TO occ_app;
--> statement-breakpoint
GRANT UPDATE (next_at_ms) ON occ.sign_in_quota_slots TO occ_app;
