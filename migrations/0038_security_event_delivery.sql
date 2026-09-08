-- Register the existing security-event delivery table definitions. Capacity
-- configuration is provisioned separately; this migration creates no spool rows.
CREATE TABLE occ.security_event_capacity_v1 (
  installation_id text PRIMARY KEY,
  max_pending_events bigint NOT NULL,
  max_pending_bytes bigint NOT NULL,
  max_retained_bytes bigint NOT NULL,
  record_overhead_bytes bigint NOT NULL,
  pending_events bigint DEFAULT 0 NOT NULL,
  pending_bytes bigint DEFAULT 0 NOT NULL,
  retained_bytes bigint DEFAULT 0 NOT NULL,
  CONSTRAINT security_event_capacity_v1_installation_id_installation_id_fk
    FOREIGN KEY (installation_id) REFERENCES occ.installation(id)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT security_event_capacity_v1_bounds CHECK (
    max_pending_events BETWEEN 1 AND 10000
    AND max_pending_bytes BETWEEN 1 AND 67108864
    AND max_retained_bytes BETWEEN 1 AND 9007199254740991
    AND record_overhead_bytes BETWEEN 1 AND 9007199254740991
    AND pending_events BETWEEN 0 AND max_pending_events
    AND pending_bytes BETWEEN 0 AND max_pending_bytes
    AND retained_bytes BETWEEN pending_bytes AND max_retained_bytes
  )
);
--> statement-breakpoint
CREATE TABLE occ.security_event_records_v1 (
  installation_id text NOT NULL,
  event_id text NOT NULL,
  namespace_id text NOT NULL,
  security_installation_id text NOT NULL,
  security_namespace_id text NOT NULL,
  audit_event_id text NOT NULL,
  original_operation_ref text NOT NULL,
  producer_instance_ref text NOT NULL,
  producer_sequence bigint NOT NULL,
  obligation_ref text NOT NULL,
  event_digest text NOT NULL,
  canonical_event_utf8 text NOT NULL,
  received_at text NOT NULL,
  commit_receipt_ref text NOT NULL,
  envelope_bytes bigint NOT NULL,
  charged_bytes bigint NOT NULL,
  CONSTRAINT security_event_records_v1_installation_id_event_id_pk
    PRIMARY KEY (installation_id, event_id),
  CONSTRAINT security_event_records_v1_event_key
    UNIQUE (security_installation_id, event_id),
  CONSTRAINT security_event_records_v1_sequence
    UNIQUE (security_installation_id, producer_instance_ref, producer_sequence),
  CONSTRAINT security_event_records_v1_obligation
    UNIQUE (security_installation_id, obligation_ref),
  CONSTRAINT security_event_records_v1_outbox UNIQUE (audit_event_id),
  CONSTRAINT security_event_records_v1_receipt UNIQUE (commit_receipt_ref),
  CONSTRAINT security_event_records_v1_installation_id_installation_id_fk
    FOREIGN KEY (installation_id) REFERENCES occ.installation(id)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT security_event_records_v1_audit_event_id_audit_export_outbox_audit_event_id_fk
    FOREIGN KEY (audit_event_id) REFERENCES occ.audit_export_outbox(audit_event_id)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT security_event_records_v1_refs CHECK (
    event_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    AND producer_instance_ref ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    AND obligation_ref ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    AND commit_receipt_ref ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  ),
  CONSTRAINT security_event_records_v1_bounds CHECK (
    producer_sequence BETWEEN 1 AND 9007199254740991
    AND octet_length(canonical_event_utf8) BETWEEN 1 AND 8192
    AND envelope_bytes BETWEEN 1 AND 16384
    AND charged_bytes BETWEEN envelope_bytes AND 9007199254740991
  ),
  CONSTRAINT security_event_records_v1_digest CHECK (
    event_digest = 'sha256:' || encode(sha256(convert_to(canonical_event_utf8, 'UTF8')), 'hex')
  ),
  CONSTRAINT security_event_records_v1_correspondence CHECK (
    coalesce((
      jsonb_typeof(canonical_event_utf8::jsonb) = 'object'
      AND canonical_event_utf8::jsonb->>'schema' = 'openclaw.security-event/v1'
      AND canonical_event_utf8::jsonb->>'id' = event_id
      AND canonical_event_utf8::jsonb->>'installationId' = security_installation_id
      AND canonical_event_utf8::jsonb->>'namespaceId' = security_namespace_id
      AND canonical_event_utf8::jsonb->>'receivedAt' = received_at
    ), false)
  )
);
--> statement-breakpoint
CREATE TRIGGER security_event_records_v1_are_immutable
BEFORE UPDATE OR DELETE ON occ.security_event_records_v1
FOR EACH ROW EXECUTE FUNCTION occ.reject_row_mutation();
--> statement-breakpoint
REVOKE ALL ON occ.security_event_capacity_v1, occ.security_event_records_v1 FROM PUBLIC, occ_app;
--> statement-breakpoint
GRANT SELECT, INSERT ON occ.security_event_records_v1 TO occ_app;
--> statement-breakpoint
GRANT SELECT ON occ.security_event_capacity_v1 TO occ_app;
--> statement-breakpoint
GRANT UPDATE (pending_events, pending_bytes, retained_bytes)
ON occ.security_event_capacity_v1 TO occ_app;
--> statement-breakpoint
-- PostgreSQL row locking requires an UPDATE privilege. The existing immutable
-- outbox trigger continues to reject every attempted UPDATE or DELETE of a row.
GRANT UPDATE (audit_event_id) ON occ.audit_export_outbox TO occ_app;
