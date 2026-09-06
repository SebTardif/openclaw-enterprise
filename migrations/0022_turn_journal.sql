CREATE TABLE "occ"."turn_journal_attempts" (
	"installation_id" text NOT NULL,
	"namespace_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"conversation_ref" text NOT NULL,
	"turn_ref" text NOT NULL,
	"attempt_ref" text NOT NULL,
	"reservation_ref" text NOT NULL,
	"channel_installation_id" text NOT NULL,
	"admission_receipt_ref" text NOT NULL,
	"first_received_at" timestamp with time zone NOT NULL,
	"reservation" jsonb NOT NULL,
	"record" jsonb,
	"version" bigint DEFAULT 1 NOT NULL,
	CONSTRAINT "turn_journal_attempts_pk" PRIMARY KEY("installation_id","namespace_id","agent_id","conversation_ref","turn_ref","attempt_ref","reservation_ref"),
	CONSTRAINT "turn_journal_attempts_turn" UNIQUE("installation_id","namespace_id","agent_id","conversation_ref","turn_ref"),
	CONSTRAINT "turn_journal_attempts_reservation" UNIQUE("installation_id","namespace_id","agent_id","reservation_ref"),
	CONSTRAINT "turn_journal_attempts_admission_unique" UNIQUE("installation_id","channel_installation_id","admission_receipt_ref"),
	CONSTRAINT "turn_journal_attempts_version" CHECK ("occ"."turn_journal_attempts"."version" BETWEEN 1 AND 9007199254740991),
	CONSTRAINT "turn_journal_attempts_first_received" CHECK (isfinite("occ"."turn_journal_attempts"."first_received_at")),
	CONSTRAINT "turn_journal_attempts_reservation_value" CHECK (jsonb_typeof("occ"."turn_journal_attempts"."reservation") = 'object' AND octet_length("occ"."turn_journal_attempts"."reservation"::text) BETWEEN 1 AND 65536),
	CONSTRAINT "turn_journal_attempts_record" CHECK ("occ"."turn_journal_attempts"."record" IS NULL OR (jsonb_typeof("occ"."turn_journal_attempts"."record") = 'object'
      AND octet_length("occ"."turn_journal_attempts"."record"::text) BETWEEN 1 AND 65536 AND ("occ"."turn_journal_attempts"."record"->>'version')::numeric = "occ"."turn_journal_attempts"."version")),
	CONSTRAINT "turn_journal_attempts_reservation_identity" CHECK (("occ"."turn_journal_attempts"."reservation"->>'reservationRef' = "occ"."turn_journal_attempts"."reservation_ref"
      AND "occ"."turn_journal_attempts"."reservation"#>>'{scope,installationId}' = "occ"."turn_journal_attempts"."installation_id"
      AND "occ"."turn_journal_attempts"."reservation"#>>'{scope,namespaceId}' = "occ"."turn_journal_attempts"."namespace_id"
      AND "occ"."turn_journal_attempts"."reservation"#>>'{scope,agentId}' = "occ"."turn_journal_attempts"."agent_id") IS TRUE)
);

--> statement-breakpoint
CREATE TABLE "occ"."turn_journal_deliveries" (
	"installation_id" text NOT NULL,
	"namespace_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"conversation_ref" text NOT NULL,
	"turn_ref" text NOT NULL,
	"attempt_ref" text NOT NULL,
	"reservation_ref" text NOT NULL,
	"slot" text NOT NULL,
	"operation_ref" text NOT NULL,
	"operation" jsonb NOT NULL,
	"delivery_attempt_ref" text,
	"attempt_number" bigint DEFAULT 0 NOT NULL,
	"episode_started_at" timestamp with time zone,
	"outcome" jsonb,
	"update_used" boolean DEFAULT false NOT NULL,
	CONSTRAINT "turn_journal_deliveries_pk" PRIMARY KEY("installation_id","namespace_id","agent_id","conversation_ref","turn_ref","attempt_ref","reservation_ref","slot"),
	CONSTRAINT "turn_journal_deliveries_operation" UNIQUE("installation_id","operation_ref"),
	CONSTRAINT "turn_journal_deliveries_slot" CHECK ("occ"."turn_journal_deliveries"."slot" IN ('completed-result','outcome-status','cancel-ack')),
	CONSTRAINT "turn_journal_deliveries_operation_value" CHECK (jsonb_typeof("occ"."turn_journal_deliveries"."operation") = 'object' AND octet_length("occ"."turn_journal_deliveries"."operation"::text) BETWEEN 1 AND 65536),
	CONSTRAINT "turn_journal_deliveries_budget" CHECK ("occ"."turn_journal_deliveries"."attempt_number" BETWEEN 0 AND 3
      AND (("occ"."turn_journal_deliveries"."attempt_number" = 0 AND "occ"."turn_journal_deliveries"."delivery_attempt_ref" IS NULL AND "occ"."turn_journal_deliveries"."episode_started_at" IS NULL AND "occ"."turn_journal_deliveries"."outcome" IS NULL)
        OR ("occ"."turn_journal_deliveries"."attempt_number" > 0 AND "occ"."turn_journal_deliveries"."delivery_attempt_ref" IS NOT NULL AND "occ"."turn_journal_deliveries"."episode_started_at" IS NOT NULL AND isfinite("occ"."turn_journal_deliveries"."episode_started_at")))
      AND (NOT "occ"."turn_journal_deliveries"."update_used" OR "occ"."turn_journal_deliveries"."slot" = 'outcome-status')),
	CONSTRAINT "turn_journal_deliveries_outcome" CHECK ("occ"."turn_journal_deliveries"."outcome" IS NULL OR (jsonb_typeof("occ"."turn_journal_deliveries"."outcome") = 'object' AND octet_length("occ"."turn_journal_deliveries"."outcome"::text) <= 65536))
);

--> statement-breakpoint
CREATE TABLE "occ"."turn_journal_delivery_attempts" (
	"installation_id" text NOT NULL,
	"namespace_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"conversation_ref" text NOT NULL,
	"turn_ref" text NOT NULL,
	"attempt_ref" text NOT NULL,
	"reservation_ref" text NOT NULL,
	"slot" text NOT NULL,
	"operation_ref" text NOT NULL,
	"operation" jsonb NOT NULL,
	"delivery_attempt_ref" text NOT NULL,
	"attempt_number" bigint NOT NULL,
	"episode_started_at" timestamp with time zone NOT NULL,
	"outcome" jsonb,
	CONSTRAINT "turn_journal_delivery_attempts_pk" PRIMARY KEY("installation_id","delivery_attempt_ref"),
	CONSTRAINT "turn_journal_delivery_attempts_number" UNIQUE("installation_id","operation_ref","attempt_number"),
	CONSTRAINT "turn_journal_delivery_attempts_slot" CHECK ("occ"."turn_journal_delivery_attempts"."slot" IN ('completed-result','outcome-status','cancel-ack')),
	CONSTRAINT "turn_journal_delivery_attempts_operation" CHECK (jsonb_typeof("occ"."turn_journal_delivery_attempts"."operation") = 'object' AND octet_length("occ"."turn_journal_delivery_attempts"."operation"::text) BETWEEN 1 AND 65536),
	CONSTRAINT "turn_journal_delivery_attempts_budget" CHECK ("occ"."turn_journal_delivery_attempts"."attempt_number" BETWEEN 1 AND 3 AND isfinite("occ"."turn_journal_delivery_attempts"."episode_started_at")
      AND ("occ"."turn_journal_delivery_attempts"."operation"#>>'{operation,kind}' = 'create'
        OR ("occ"."turn_journal_delivery_attempts"."operation"#>>'{operation,kind}' = 'update' AND "occ"."turn_journal_delivery_attempts"."attempt_number" = 1 AND "occ"."turn_journal_delivery_attempts"."slot" = 'outcome-status'))),
	CONSTRAINT "turn_journal_delivery_attempts_outcome" CHECK ("occ"."turn_journal_delivery_attempts"."outcome" IS NULL OR (jsonb_typeof("occ"."turn_journal_delivery_attempts"."outcome") = 'object' AND octet_length("occ"."turn_journal_delivery_attempts"."outcome"::text) <= 65536))
);

--> statement-breakpoint
CREATE TABLE "occ"."turn_journal_heads" (
	"installation_id" text NOT NULL,
	"namespace_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"conversation_ref" text NOT NULL,
	"record" jsonb NOT NULL,
	"checkpoint" jsonb,
	CONSTRAINT "turn_journal_heads_pk" PRIMARY KEY("installation_id","namespace_id","agent_id","conversation_ref"),
	CONSTRAINT "turn_journal_heads_record" CHECK (jsonb_typeof("occ"."turn_journal_heads"."record") = 'object' AND octet_length("occ"."turn_journal_heads"."record"::text) BETWEEN 1 AND 65536),
	CONSTRAINT "turn_journal_heads_checkpoint" CHECK ("occ"."turn_journal_heads"."checkpoint" IS NULL OR (jsonb_typeof("occ"."turn_journal_heads"."checkpoint") = 'object'
      AND octet_length("occ"."turn_journal_heads"."checkpoint"::text) BETWEEN 1 AND 65536)),
	CONSTRAINT "turn_journal_heads_identity" CHECK (("occ"."turn_journal_heads"."record"#>>'{context,installationRef}' = "occ"."turn_journal_heads"."installation_id"
      AND "occ"."turn_journal_heads"."record"#>>'{context,namespaceRef}' = "occ"."turn_journal_heads"."namespace_id"
      AND "occ"."turn_journal_heads"."record"#>>'{context,agentRef}' = "occ"."turn_journal_heads"."agent_id"
      AND "occ"."turn_journal_heads"."record"#>>'{context,conversationRef}' = "occ"."turn_journal_heads"."conversation_ref"
      AND ("occ"."turn_journal_heads"."record"->>'headVersion')::numeric BETWEEN 1 AND 9007199254740991
      AND ("occ"."turn_journal_heads"."record"->>'completionSequence')::numeric BETWEEN 0 AND 9007199254740991
      AND CASE WHEN ("occ"."turn_journal_heads"."record"->>'completionSequence')::numeric = 0
        THEN "occ"."turn_journal_heads"."record"->'checkpointId' = 'null'::jsonb AND "occ"."turn_journal_heads"."checkpoint" IS NULL
        ELSE "occ"."turn_journal_heads"."checkpoint"->>'checkpointId' = "occ"."turn_journal_heads"."record"->>'checkpointId'
          AND "occ"."turn_journal_heads"."checkpoint"->'completionSequence' = "occ"."turn_journal_heads"."record"->'completionSequence' END) IS TRUE)
);

--> statement-breakpoint
CREATE TABLE "occ"."turn_journal_incoming_links" (
	"installation_id" text NOT NULL,
	"channel_installation_id" text NOT NULL,
	"incoming_link_ref" text NOT NULL,
	"event_owner" boolean NOT NULL,
	"link_kind" text NOT NULL,
	"incoming_identity_digest" text NOT NULL,
	"event_key" text NOT NULL,
	"incoming_event_digest" text NOT NULL,
	"incoming_content_digest" text,
	"record" jsonb NOT NULL,
	CONSTRAINT "turn_journal_incoming_links_pk" PRIMARY KEY("installation_id","channel_installation_id","incoming_link_ref"),
	CONSTRAINT "turn_journal_links_kind" CHECK ("occ"."turn_journal_incoming_links"."link_kind" IN ('admission', 'non-turn')),
	CONSTRAINT "turn_journal_links_digests" CHECK ("occ"."turn_journal_incoming_links"."incoming_identity_digest" ~ '^[0-9a-f]{64}$'
      AND "occ"."turn_journal_incoming_links"."event_key" ~ '^[0-9a-f]{64}$' AND "occ"."turn_journal_incoming_links"."incoming_event_digest" ~ '^[0-9a-f]{64}$'
      AND ("occ"."turn_journal_incoming_links"."incoming_content_digest" IS NULL OR "occ"."turn_journal_incoming_links"."incoming_content_digest" ~ '^[0-9a-f]{64}$')),
	CONSTRAINT "turn_journal_links_record" CHECK (jsonb_typeof("occ"."turn_journal_incoming_links"."record") = 'object' AND octet_length("occ"."turn_journal_incoming_links"."record"::text) BETWEEN 1 AND 65536),
	CONSTRAINT "turn_journal_links_identity" CHECK (("occ"."turn_journal_incoming_links"."record"->>'incomingLinkRef' = "occ"."turn_journal_incoming_links"."incoming_link_ref"
      AND CASE "occ"."turn_journal_incoming_links"."link_kind" WHEN 'admission' THEN (
        "occ"."turn_journal_incoming_links"."record"#>>'{locator,installationRef}' = "occ"."turn_journal_incoming_links"."installation_id"
        AND "occ"."turn_journal_incoming_links"."record"#>>'{locator,channelInstallationRef}' = "occ"."turn_journal_incoming_links"."channel_installation_id"
        AND "occ"."turn_journal_incoming_links"."record"#>>'{locator,eventKey}' = "occ"."turn_journal_incoming_links"."event_key"
        AND "occ"."turn_journal_incoming_links"."record"->>'incomingIdentityDigest' = "occ"."turn_journal_incoming_links"."incoming_identity_digest"
        AND "occ"."turn_journal_incoming_links"."record"->>'incomingEventDigest' = "occ"."turn_journal_incoming_links"."incoming_event_digest"
        AND "occ"."turn_journal_incoming_links"."record"->>'incomingContentDigest' = "occ"."turn_journal_incoming_links"."incoming_content_digest")
      ELSE ("occ"."turn_journal_incoming_links"."record"#>>'{intake,installationRef}' = "occ"."turn_journal_incoming_links"."installation_id"
        AND "occ"."turn_journal_incoming_links"."record"#>>'{intake,channelInstallationRef}' = "occ"."turn_journal_incoming_links"."channel_installation_id"
        AND "occ"."turn_journal_incoming_links"."record"#>>'{intake,eventKey}' = "occ"."turn_journal_incoming_links"."event_key"
        AND "occ"."turn_journal_incoming_links"."record"#>>'{intake,eventDigest}' = "occ"."turn_journal_incoming_links"."incoming_event_digest"
        AND "occ"."turn_journal_incoming_links"."incoming_content_digest" IS NULL) END) IS TRUE)
);

--> statement-breakpoint
CREATE TABLE "occ"."turn_journal_keys" (
	"installation_id" text NOT NULL,
	"channel_installation_id" text NOT NULL,
	"key_kind" text NOT NULL,
	"key_digest" text NOT NULL,
	"receipt_ref" text NOT NULL,
	CONSTRAINT "turn_journal_keys_pk" PRIMARY KEY("installation_id","channel_installation_id","key_kind","key_digest"),
	CONSTRAINT "turn_journal_keys_kind" CHECK ("occ"."turn_journal_keys"."key_kind" IN ('event', 'logical-message')),
	CONSTRAINT "turn_journal_keys_digest" CHECK ("occ"."turn_journal_keys"."key_digest" ~ '^[0-9a-f]{64}$')
);

--> statement-breakpoint
CREATE TABLE "occ"."turn_journal_operations" (
	"installation_id" text NOT NULL,
	"namespace_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"conversation_ref" text NOT NULL,
	"turn_ref" text NOT NULL,
	"attempt_ref" text NOT NULL,
	"reservation_ref" text NOT NULL,
	"operation_kind" text NOT NULL,
	"operation_ref" text NOT NULL,
	"request" jsonb NOT NULL,
	"record" jsonb NOT NULL,
	CONSTRAINT "turn_journal_operations_pk" PRIMARY KEY("installation_id","operation_kind","operation_ref"),
	CONSTRAINT "turn_journal_operations_kind" CHECK ("occ"."turn_journal_operations"."operation_kind" IN ('checkpoint-allocation','completion','outcome','cancellation','release')),
	CONSTRAINT "turn_journal_operations_request" CHECK (jsonb_typeof("occ"."turn_journal_operations"."request") = 'object' AND octet_length("occ"."turn_journal_operations"."request"::text) BETWEEN 1 AND 65536),
	CONSTRAINT "turn_journal_operations_record" CHECK (jsonb_typeof("occ"."turn_journal_operations"."record") = 'object' AND octet_length("occ"."turn_journal_operations"."record"::text) BETWEEN 1 AND 65536)
);

--> statement-breakpoint
CREATE TABLE "occ"."turn_journal_owners" (
	"installation_id" text NOT NULL,
	"channel_installation_id" text NOT NULL,
	"receipt_ref" text NOT NULL,
	"owner_kind" text NOT NULL,
	"record" jsonb NOT NULL,
	CONSTRAINT "turn_journal_owners_pk" PRIMARY KEY("installation_id","channel_installation_id","receipt_ref"),
	CONSTRAINT "turn_journal_owners_kind" CHECK ("occ"."turn_journal_owners"."owner_kind" IN ('admission', 'rejected', 'non-turn')),
	CONSTRAINT "turn_journal_owners_record" CHECK (jsonb_typeof("occ"."turn_journal_owners"."record") = 'object' AND octet_length("occ"."turn_journal_owners"."record"::text) BETWEEN 1 AND 65536),
	CONSTRAINT "turn_journal_owners_identity" CHECK (CASE "occ"."turn_journal_owners"."owner_kind"
      WHEN 'admission' THEN ("occ"."turn_journal_owners"."record"#>>'{identity,receipt,receiptRef}' = "occ"."turn_journal_owners"."receipt_ref"
        AND "occ"."turn_journal_owners"."record"#>>'{identity,locator,installationRef}' = "occ"."turn_journal_owners"."installation_id"
        AND "occ"."turn_journal_owners"."record"#>>'{identity,locator,channelInstallationRef}' = "occ"."turn_journal_owners"."channel_installation_id")
      WHEN 'rejected' THEN ("occ"."turn_journal_owners"."record"#>>'{receipt,receiptRef}' = "occ"."turn_journal_owners"."receipt_ref"
        AND "occ"."turn_journal_owners"."record"#>>'{envelope,installationRef}' = "occ"."turn_journal_owners"."installation_id"
        AND "occ"."turn_journal_owners"."record"#>>'{envelope,channelInstallationRef}' = "occ"."turn_journal_owners"."channel_installation_id")
      ELSE ("occ"."turn_journal_owners"."record"->>'receiptRef' = "occ"."turn_journal_owners"."receipt_ref"
        AND "occ"."turn_journal_owners"."record"#>>'{intake,installationRef}' = "occ"."turn_journal_owners"."installation_id"
        AND "occ"."turn_journal_owners"."record"#>>'{intake,channelInstallationRef}' = "occ"."turn_journal_owners"."channel_installation_id") END IS TRUE)
);

--> statement-breakpoint
CREATE TABLE "occ"."turn_journal_reservations" (
	"installation_id" text NOT NULL,
	"namespace_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"conversation_ref" text NOT NULL,
	"turn_ref" text NOT NULL,
	"attempt_ref" text NOT NULL,
	"reservation_ref" text NOT NULL,
	CONSTRAINT "turn_journal_reservations_pk" PRIMARY KEY("installation_id","namespace_id","agent_id")
);

--> statement-breakpoint
ALTER TABLE "occ"."turn_journal_attempts" ADD CONSTRAINT "turn_journal_attempts_installation_id_installation_id_fk" FOREIGN KEY ("installation_id") REFERENCES "occ"."installation"("id") ON DELETE restrict ON UPDATE restrict;
--> statement-breakpoint
ALTER TABLE "occ"."turn_journal_attempts" ADD CONSTRAINT "turn_journal_attempts_agent" FOREIGN KEY ("namespace_id","agent_id") REFERENCES "occ"."agents"("namespace_id","id") ON DELETE restrict ON UPDATE restrict;
--> statement-breakpoint
ALTER TABLE "occ"."turn_journal_attempts" ADD CONSTRAINT "turn_journal_attempts_admission" FOREIGN KEY ("installation_id","channel_installation_id","admission_receipt_ref") REFERENCES "occ"."turn_journal_owners"("installation_id","channel_installation_id","receipt_ref") ON DELETE restrict ON UPDATE restrict;
--> statement-breakpoint
ALTER TABLE "occ"."turn_journal_deliveries" ADD CONSTRAINT "turn_journal_deliveries_installation_id_installation_id_fk" FOREIGN KEY ("installation_id") REFERENCES "occ"."installation"("id") ON DELETE restrict ON UPDATE restrict;
--> statement-breakpoint
ALTER TABLE "occ"."turn_journal_deliveries" ADD CONSTRAINT "turn_journal_deliveries_attempt" FOREIGN KEY ("installation_id","namespace_id","agent_id","conversation_ref","turn_ref","attempt_ref","reservation_ref") REFERENCES "occ"."turn_journal_attempts"("installation_id","namespace_id","agent_id","conversation_ref","turn_ref","attempt_ref","reservation_ref") ON DELETE restrict ON UPDATE restrict;
--> statement-breakpoint
ALTER TABLE "occ"."turn_journal_delivery_attempts" ADD CONSTRAINT "turn_journal_delivery_attempts_attempt" FOREIGN KEY ("installation_id","namespace_id","agent_id","conversation_ref","turn_ref","attempt_ref","reservation_ref") REFERENCES "occ"."turn_journal_attempts"("installation_id","namespace_id","agent_id","conversation_ref","turn_ref","attempt_ref","reservation_ref") ON DELETE restrict ON UPDATE restrict;
--> statement-breakpoint
ALTER TABLE "occ"."turn_journal_delivery_attempts" ADD CONSTRAINT "turn_journal_delivery_history_installation" FOREIGN KEY ("installation_id") REFERENCES "occ"."installation"("id") ON DELETE restrict ON UPDATE restrict;
--> statement-breakpoint
ALTER TABLE "occ"."turn_journal_heads" ADD CONSTRAINT "turn_journal_heads_installation_id_installation_id_fk" FOREIGN KEY ("installation_id") REFERENCES "occ"."installation"("id") ON DELETE restrict ON UPDATE restrict;
--> statement-breakpoint
ALTER TABLE "occ"."turn_journal_heads" ADD CONSTRAINT "turn_journal_heads_agent" FOREIGN KEY ("namespace_id","agent_id") REFERENCES "occ"."agents"("namespace_id","id") ON DELETE restrict ON UPDATE restrict;
--> statement-breakpoint
ALTER TABLE "occ"."turn_journal_incoming_links" ADD CONSTRAINT "turn_journal_incoming_links_installation_id_installation_id_fk" FOREIGN KEY ("installation_id") REFERENCES "occ"."installation"("id") ON DELETE restrict ON UPDATE restrict;
--> statement-breakpoint
ALTER TABLE "occ"."turn_journal_incoming_links" ADD CONSTRAINT "turn_journal_links_channel" FOREIGN KEY ("installation_id","channel_installation_id") REFERENCES "occ"."channel_installations"("installation_id","id") ON DELETE restrict ON UPDATE restrict;
--> statement-breakpoint
ALTER TABLE "occ"."turn_journal_keys" ADD CONSTRAINT "turn_journal_keys_installation_id_installation_id_fk" FOREIGN KEY ("installation_id") REFERENCES "occ"."installation"("id") ON DELETE restrict ON UPDATE restrict;
--> statement-breakpoint
ALTER TABLE "occ"."turn_journal_keys" ADD CONSTRAINT "turn_journal_keys_owner" FOREIGN KEY ("installation_id","channel_installation_id","receipt_ref") REFERENCES "occ"."turn_journal_owners"("installation_id","channel_installation_id","receipt_ref") ON DELETE restrict ON UPDATE restrict;
--> statement-breakpoint
ALTER TABLE "occ"."turn_journal_operations" ADD CONSTRAINT "turn_journal_operations_installation_id_installation_id_fk" FOREIGN KEY ("installation_id") REFERENCES "occ"."installation"("id") ON DELETE restrict ON UPDATE restrict;
--> statement-breakpoint
ALTER TABLE "occ"."turn_journal_operations" ADD CONSTRAINT "turn_journal_operations_attempt" FOREIGN KEY ("installation_id","namespace_id","agent_id","conversation_ref","turn_ref","attempt_ref","reservation_ref") REFERENCES "occ"."turn_journal_attempts"("installation_id","namespace_id","agent_id","conversation_ref","turn_ref","attempt_ref","reservation_ref") ON DELETE restrict ON UPDATE restrict;
--> statement-breakpoint
ALTER TABLE "occ"."turn_journal_owners" ADD CONSTRAINT "turn_journal_owners_installation_id_installation_id_fk" FOREIGN KEY ("installation_id") REFERENCES "occ"."installation"("id") ON DELETE restrict ON UPDATE restrict;
--> statement-breakpoint
ALTER TABLE "occ"."turn_journal_owners" ADD CONSTRAINT "turn_journal_owners_channel" FOREIGN KEY ("installation_id","channel_installation_id") REFERENCES "occ"."channel_installations"("installation_id","id") ON DELETE restrict ON UPDATE restrict;
--> statement-breakpoint
ALTER TABLE "occ"."turn_journal_reservations" ADD CONSTRAINT "turn_journal_reservations_installation_id_installation_id_fk" FOREIGN KEY ("installation_id") REFERENCES "occ"."installation"("id") ON DELETE restrict ON UPDATE restrict;
--> statement-breakpoint
ALTER TABLE "occ"."turn_journal_reservations" ADD CONSTRAINT "turn_journal_reservations_attempt" FOREIGN KEY ("installation_id","namespace_id","agent_id","conversation_ref","turn_ref","attempt_ref","reservation_ref") REFERENCES "occ"."turn_journal_attempts"("installation_id","namespace_id","agent_id","conversation_ref","turn_ref","attempt_ref","reservation_ref") ON DELETE restrict ON UPDATE restrict;
--> statement-breakpoint
CREATE UNIQUE INDEX "turn_journal_links_event_owner" ON "occ"."turn_journal_incoming_links" USING btree ("installation_id","channel_installation_id","event_key") WHERE "occ"."turn_journal_incoming_links"."event_owner";
--> statement-breakpoint
CREATE UNIQUE INDEX "turn_journal_links_exact" ON "occ"."turn_journal_incoming_links" USING btree ("installation_id","channel_installation_id","event_key","incoming_event_digest",coalesce("incoming_content_digest", ''),"incoming_identity_digest");
--> statement-breakpoint
CREATE UNIQUE INDEX "turn_journal_operations_once" ON "occ"."turn_journal_operations" USING btree ("installation_id","namespace_id","agent_id","conversation_ref","turn_ref","attempt_ref","reservation_ref","operation_kind") WHERE "occ"."turn_journal_operations"."operation_kind" IN ('checkpoint-allocation','completion','cancellation','release');
--> statement-breakpoint
CREATE UNIQUE INDEX "turn_journal_checkpoint_allocation_id" ON "occ"."turn_journal_operations" USING btree ("installation_id",("request"->>'checkpointId')) WHERE "occ"."turn_journal_operations"."operation_kind" = 'checkpoint-allocation';
--> statement-breakpoint
CREATE UNIQUE INDEX "turn_journal_completion_sequence" ON "occ"."turn_journal_operations" USING btree ("installation_id","namespace_id","agent_id","conversation_ref",("record"#>>'{head,completionSequence}')) WHERE "occ"."turn_journal_operations"."operation_kind" = 'completion';

--> statement-breakpoint
-- Admission owner/key/link invariants. Apply after the turn_journal tables exist.
-- Keys follow owners because their FK and correlation trigger are immediate.
-- Completeness and link-owner checks run at transaction end, so remaining keys
-- and incoming links may be inserted in either order in the same outer UoW.

CREATE OR REPLACE FUNCTION occ.turn_journal_admission_immutable()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, occ AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Immutable turn journal admission state' USING ERRCODE = '23514';
  END IF;
  IF NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'Immutable turn journal admission state' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER turn_journal_owners_immutable
BEFORE UPDATE OR DELETE ON occ.turn_journal_owners
FOR EACH ROW EXECUTE FUNCTION occ.turn_journal_admission_immutable();

CREATE TRIGGER turn_journal_keys_immutable
BEFORE UPDATE OR DELETE ON occ.turn_journal_keys
FOR EACH ROW EXECUTE FUNCTION occ.turn_journal_admission_immutable();

CREATE TRIGGER turn_journal_incoming_links_immutable
BEFORE UPDATE OR DELETE ON occ.turn_journal_incoming_links
FOR EACH ROW EXECUTE FUNCTION occ.turn_journal_admission_immutable();

CREATE OR REPLACE FUNCTION occ.turn_journal_key_matches_owner()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, occ AS $$
DECLARE
  owner_row occ.turn_journal_owners%ROWTYPE;
  expected_digest text;
BEGIN
  SELECT * INTO owner_row FROM occ.turn_journal_owners
  WHERE installation_id = NEW.installation_id
    AND channel_installation_id = NEW.channel_installation_id
    AND receipt_ref = NEW.receipt_ref;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Turn journal key owner is missing' USING ERRCODE = '23514';
  END IF;
  IF NEW.key_kind = 'event' THEN
    expected_digest := CASE owner_row.owner_kind
      WHEN 'admission' THEN owner_row.record #>> '{identity,receipt,eventKey}'
      WHEN 'rejected' THEN owner_row.record #>> '{receipt,eventKey}'
      WHEN 'non-turn' THEN owner_row.record #>> '{intake,eventKey}'
      ELSE NULL END;
  ELSIF NEW.key_kind = 'logical-message' THEN
    expected_digest := CASE owner_row.owner_kind
      WHEN 'admission' THEN owner_row.record #>> '{identity,receipt,logicalMessageKey}'
      WHEN 'rejected' THEN owner_row.record #>> '{receipt,logicalMessageKey}'
      WHEN 'non-turn' THEN CASE
        WHEN owner_row.record #>> '{intake,logicalMessage,kind}' = 'equivalent-original'
          AND owner_row.record #>> '{intake,classification}' IN ('bot-original', 'unaddressed-original')
        THEN owner_row.record #>> '{intake,logicalMessage,logicalMessageKey}'
        ELSE NULL END
      ELSE NULL END;
  END IF;
  IF expected_digest IS NULL OR expected_digest IS DISTINCT FROM NEW.key_digest THEN
    RAISE EXCEPTION 'Turn journal key does not match original owner' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER turn_journal_keys_match_owner
BEFORE INSERT ON occ.turn_journal_keys
FOR EACH ROW EXECUTE FUNCTION occ.turn_journal_key_matches_owner();

CREATE OR REPLACE FUNCTION occ.turn_journal_owner_keys_complete()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, occ AS $$
DECLARE
  event_digest text;
  logical_digest text;
  logical_required boolean;
BEGIN
  CASE NEW.owner_kind
    WHEN 'admission' THEN
      event_digest := NEW.record #>> '{identity,receipt,eventKey}';
      logical_digest := NEW.record #>> '{identity,receipt,logicalMessageKey}';
      logical_required := true;
    WHEN 'rejected' THEN
      event_digest := NEW.record #>> '{receipt,eventKey}';
      logical_digest := NEW.record #>> '{receipt,logicalMessageKey}';
      logical_required := true;
    WHEN 'non-turn' THEN
      event_digest := NEW.record #>> '{intake,eventKey}';
      logical_required := (NEW.record #>> '{intake,logicalMessage,kind}' = 'equivalent-original');
      logical_digest := CASE WHEN logical_required
        THEN NEW.record #>> '{intake,logicalMessage,logicalMessageKey}' ELSE NULL END;
    ELSE
      RAISE EXCEPTION 'Invalid turn journal owner' USING ERRCODE = '23514';
  END CASE;
  IF event_digest IS NULL OR NOT EXISTS (
    SELECT 1 FROM occ.turn_journal_keys
    WHERE installation_id = NEW.installation_id
      AND channel_installation_id = NEW.channel_installation_id
      AND receipt_ref = NEW.receipt_ref
      AND key_kind = 'event' AND key_digest = event_digest
  ) THEN
    RAISE EXCEPTION 'Turn journal original event ownership is missing' USING ERRCODE = '23514';
  END IF;
  IF logical_required AND (logical_digest IS NULL OR NOT EXISTS (
    SELECT 1 FROM occ.turn_journal_keys
    WHERE installation_id = NEW.installation_id
      AND channel_installation_id = NEW.channel_installation_id
      AND receipt_ref = NEW.receipt_ref
      AND key_kind = 'logical-message' AND key_digest = logical_digest
  )) THEN
    RAISE EXCEPTION 'Turn journal original logical ownership is missing' USING ERRCODE = '23514';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM occ.turn_journal_incoming_links anchor
    WHERE anchor.installation_id=NEW.installation_id AND anchor.channel_installation_id=NEW.channel_installation_id
      AND anchor.event_key=event_digest AND anchor.event_owner
      AND CASE WHEN NEW.owner_kind='non-turn' THEN
        anchor.link_kind='non-turn' AND anchor.record=NEW.record
          AND anchor.record->'originalReceiptRefs'='[]'::jsonb
      ELSE anchor.link_kind='admission' AND anchor.record->>'disposition'='original'
        AND anchor.record->'originalReceiptRefs'=jsonb_build_array(NEW.receipt_ref)
        AND anchor.incoming_event_digest=CASE WHEN NEW.owner_kind='admission'
          THEN NEW.record#>>'{identity,receipt,eventDigest}' ELSE NEW.record#>>'{receipt,eventDigest}' END
        AND anchor.incoming_content_digest=CASE WHEN NEW.owner_kind='admission'
          THEN NEW.record#>>'{identity,receipt,contentDigest}' ELSE NEW.record#>>'{receipt,contentDigest}' END
      END) THEN
    RAISE EXCEPTION 'Turn journal original incoming link is missing' USING ERRCODE='23514';
  END IF;
  IF NEW.owner_kind='admission' AND NEW.record#>>'{decision,kind}'='accepted' THEN
    IF NOT EXISTS (SELECT 1 FROM occ.turn_journal_attempts a
      WHERE a.installation_id=NEW.installation_id AND a.channel_installation_id=NEW.channel_installation_id
        AND a.admission_receipt_ref=NEW.receipt_ref
        AND NEW.record#>'{decision,attempt}'=jsonb_build_object(
          'installationRef',a.installation_id,'namespaceRef',a.namespace_id,'agentRef',a.agent_id,
          'conversationRef',a.conversation_ref,'turnRef',a.turn_ref,'attemptRef',a.attempt_ref,'reservationRef',a.reservation_ref)
        AND (EXISTS (SELECT 1 FROM occ.turn_journal_reservations r WHERE r.installation_id=a.installation_id
          AND r.namespace_id=a.namespace_id AND r.agent_id=a.agent_id AND r.conversation_ref=a.conversation_ref
          AND r.turn_ref=a.turn_ref AND r.attempt_ref=a.attempt_ref AND r.reservation_ref=a.reservation_ref)
        OR EXISTS (SELECT 1 FROM occ.turn_journal_operations op WHERE op.installation_id=a.installation_id
          AND op.namespace_id=a.namespace_id AND op.agent_id=a.agent_id AND op.conversation_ref=a.conversation_ref
          AND op.turn_ref=a.turn_ref AND op.attempt_ref=a.attempt_ref AND op.reservation_ref=a.reservation_ref
          AND op.operation_kind='release'))
        AND EXISTS (SELECT 1 FROM occ.turn_journal_heads h WHERE h.installation_id=a.installation_id
          AND h.namespace_id=a.namespace_id AND h.agent_id=a.agent_id AND h.conversation_ref=a.conversation_ref)) THEN
      RAISE EXCEPTION 'Turn journal acceptance is not atomic' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER turn_journal_owners_keys_complete
AFTER INSERT ON occ.turn_journal_owners
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION occ.turn_journal_owner_keys_complete();

CREATE OR REPLACE FUNCTION occ.turn_journal_link_owners_exist()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, occ AS $$
DECLARE
  receipt_refs jsonb;
  receipt_count integer;
  receipt_value jsonb;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM occ.turn_journal_incoming_links anchor
    WHERE anchor.installation_id=NEW.installation_id AND anchor.channel_installation_id=NEW.channel_installation_id
      AND anchor.event_key=NEW.event_key AND anchor.event_owner) THEN
    RAISE EXCEPTION 'Turn journal incoming event owner anchor is missing' USING ERRCODE='23514';
  END IF;
  receipt_refs := NEW.record -> 'originalReceiptRefs';
  IF jsonb_typeof(receipt_refs) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'Invalid turn journal incoming owner references' USING ERRCODE = '23514';
  END IF;
  receipt_count := jsonb_array_length(receipt_refs);
  IF receipt_count > 2 OR (NEW.link_kind = 'admission' AND receipt_count = 0) THEN
    RAISE EXCEPTION 'Invalid turn journal incoming owner count' USING ERRCODE = '23514';
  END IF;
  IF receipt_count = 2 AND receipt_refs -> 0 = receipt_refs -> 1 THEN
    RAISE EXCEPTION 'Duplicate turn journal incoming owner reference' USING ERRCODE = '23514';
  END IF;
  FOR receipt_value IN SELECT value FROM jsonb_array_elements(receipt_refs) LOOP
    IF jsonb_typeof(receipt_value) IS DISTINCT FROM 'string' OR NOT EXISTS (
      SELECT 1 FROM occ.turn_journal_owners
      WHERE installation_id = NEW.installation_id
        AND channel_installation_id = NEW.channel_installation_id
        AND receipt_ref = receipt_value #>> '{}'
    ) THEN
      RAISE EXCEPTION 'Turn journal incoming original owner is missing' USING ERRCODE = '23514';
    END IF;
  END LOOP;
  -- A first non-turn handling receipt has no previous original owner. Its own
  -- immutable owner must be retained in this transaction, using the exact record.
  -- Duplicate/conflict handling receipts need only their referenced originals.
  IF receipt_count = 0 AND (NEW.link_kind <> 'non-turn' OR NOT EXISTS (
    SELECT 1 FROM occ.turn_journal_owners
    WHERE installation_id = NEW.installation_id
      AND channel_installation_id = NEW.channel_installation_id
      AND receipt_ref = NEW.record ->> 'receiptRef'
      AND owner_kind = 'non-turn' AND record = NEW.record
  )) THEN
    RAISE EXCEPTION 'Turn journal first non-turn owner is missing' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER turn_journal_links_owners_exist
AFTER INSERT ON occ.turn_journal_incoming_links
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION occ.turn_journal_link_owners_exist();

--> statement-breakpoint
CREATE FUNCTION occ.turn_journal_attempt_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, occ AS $$
DECLARE
  admission jsonb;
  exact_attempt jsonb;
  previous_kind text;
  next_kind text;
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Turn journal attempts are immutable history' USING ERRCODE = '23514'; END IF;
  exact_attempt := jsonb_build_object('installationRef', NEW.installation_id,
    'namespaceRef', NEW.namespace_id, 'agentRef', NEW.agent_id,
    'conversationRef', NEW.conversation_ref, 'turnRef', NEW.turn_ref,
    'attemptRef', NEW.attempt_ref, 'reservationRef', NEW.reservation_ref);
  SELECT record INTO admission FROM occ.turn_journal_owners
    WHERE installation_id = NEW.installation_id AND channel_installation_id = NEW.channel_installation_id
      AND receipt_ref = NEW.admission_receipt_ref AND owner_kind = 'admission';
  IF admission IS NULL OR (admission#>>'{decision,kind}') IS DISTINCT FROM 'accepted'
    OR (admission#>'{decision,attempt}') IS DISTINCT FROM exact_attempt THEN
    RAISE EXCEPTION 'Turn journal attempt admission mismatch' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NOT isfinite(NEW.first_received_at)
      OR ((admission->>'decidedAt')::timestamptz >= NEW.first_received_at
        AND (admission->>'decidedAt')::timestamptz <= NEW.first_received_at+interval '30 seconds') IS NOT TRUE THEN
      RAISE EXCEPTION 'Turn journal first receipt admission window mismatch' USING ERRCODE='23514';
    END IF;
    IF NEW.record IS NOT NULL OR NEW.version <> 1 THEN
      RAISE EXCEPTION 'Turn journal attempt must start undispatched' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW IS NOT DISTINCT FROM OLD THEN RETURN NEW; END IF;
  IF (to_jsonb(NEW) - 'record' - 'version') IS DISTINCT FROM (to_jsonb(OLD) - 'record' - 'version')
    OR NEW.version <> OLD.version + 1 OR NEW.record IS NULL THEN
    RAISE EXCEPTION 'Turn journal attempt transition mismatch' USING ERRCODE = '23514';
  END IF;
  IF (NEW.record#>'{binding,attempt}') IS DISTINCT FROM exact_attempt
    OR (NEW.record#>'{binding,identity}') IS DISTINCT FROM (admission->'identity')
    OR (NEW.record#>'{binding,expectedHead}') IS DISTINCT FROM (admission->'expectedHead')
    OR (NEW.record#>'{binding,reservation}') IS DISTINCT FROM NEW.reservation THEN
    RAISE EXCEPTION 'Turn journal attempt binding mismatch' USING ERRCODE = '23514';
  END IF;
  next_kind := NEW.record#>>'{outcome,kind}';
  IF next_kind IS NULL OR next_kind NOT IN ('accepted-undispatched','dispatch-intent','consumed','running','completed','failed','interrupted','outcome-unknown','cancelled')
    OR NOT NEW.record ? 'consumption' THEN
    RAISE EXCEPTION 'Turn journal attempt outcome missing' USING ERRCODE = '23514';
  END IF;
  -- A retained requested cancellation owns the next version transition. This
  -- excludes a completion/outcome update that tries to skip its metadata bump.
  IF OLD.record IS NOT NULL AND EXISTS (SELECT 1 FROM occ.turn_journal_operations op
    WHERE op.installation_id=OLD.installation_id AND op.namespace_id=OLD.namespace_id AND op.agent_id=OLD.agent_id
      AND op.conversation_ref=OLD.conversation_ref AND op.turn_ref=OLD.turn_ref
      AND op.attempt_ref=OLD.attempt_ref AND op.reservation_ref=OLD.reservation_ref
      AND op.operation_kind='cancellation' AND op.record->>'outcome'='requested'
      AND (op.request->>'expectedAttemptVersion')::numeric=OLD.version) THEN
    IF (NEW.record-'version') IS DISTINCT FROM (OLD.record-'version')
      OR NEW.record->'version' IS DISTINCT FROM to_jsonb(NEW.version)
      OR OLD.record#>>'{outcome,kind}' IN ('completed','failed','interrupted','cancelled') THEN
      RAISE EXCEPTION 'Turn journal cancellation version transition mismatch' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.record IS NULL THEN
    IF clock_timestamp() >= OLD.first_received_at+interval '30 seconds'
      OR next_kind <> 'dispatch-intent' OR NEW.record->'consumption' IS DISTINCT FROM 'null'::jsonb
      OR (NEW.record#>>'{outcome,dispatchOperationRef}') IS DISTINCT FROM (NEW.record#>>'{binding,dispatchOperationRef}')
      OR EXISTS (SELECT 1 FROM occ.turn_journal_operations op WHERE op.installation_id=NEW.installation_id
        AND op.namespace_id=NEW.namespace_id AND op.agent_id=NEW.agent_id AND op.conversation_ref=NEW.conversation_ref
        AND op.turn_ref=NEW.turn_ref AND op.attempt_ref=NEW.attempt_ref AND op.reservation_ref=NEW.reservation_ref
        AND op.operation_kind='cancellation' AND op.record->>'outcome'='cancelled-before-dispatch') THEN
      RAISE EXCEPTION 'Turn journal dispatch no longer admissible' USING ERRCODE = '23514';
    END IF;
  ELSE
    previous_kind := OLD.record#>>'{outcome,kind}';
    IF NEW.record->'binding' IS DISTINCT FROM OLD.record->'binding'
      OR previous_kind IN ('completed','failed','interrupted','cancelled')
      OR (OLD.record->'consumption' IS DISTINCT FROM 'null'::jsonb
        AND NEW.record->'consumption' IS DISTINCT FROM OLD.record->'consumption') THEN
      RAISE EXCEPTION 'Turn journal attempt history changed' USING ERRCODE = '23514';
    END IF;
    IF OLD.record->'consumption' IS NOT DISTINCT FROM 'null'::jsonb
      AND NEW.record->'consumption' IS DISTINCT FROM 'null'::jsonb AND next_kind <> 'consumed' THEN
      RAISE EXCEPTION 'Turn journal consumption must be committed separately' USING ERRCODE='23514';
    END IF;
    IF next_kind = 'consumed' THEN
      IF previous_kind <> 'dispatch-intent' OR OLD.record->'consumption' IS DISTINCT FROM 'null'::jsonb
        OR NEW.record->'consumption' IS NOT DISTINCT FROM 'null'::jsonb THEN
        RAISE EXCEPTION 'Turn journal consumption transition invalid' USING ERRCODE = '23514';
      END IF;
    ELSIF next_kind = 'running' THEN
      IF previous_kind <> 'consumed' THEN RAISE EXCEPTION 'Turn journal running transition invalid' USING ERRCODE = '23514'; END IF;
    ELSIF next_kind = 'completed' THEN
      IF NOT (NEW.record#>'{outcome,checkpoint}' @> exact_attempt) THEN
        RAISE EXCEPTION 'Turn journal completed checkpoint owner mismatch' USING ERRCODE='23514';
      END IF;
      IF previous_kind NOT IN ('consumed','running')
        AND NOT (previous_kind='outcome-unknown' AND OLD.record#>>'{outcome,stage}' IN ('execution','checkpoint')) THEN
        RAISE EXCEPTION 'Turn journal completion transition invalid' USING ERRCODE = '23514';
      END IF;
    ELSIF next_kind IN ('failed','interrupted','outcome-unknown','cancelled') THEN
      IF (NEW.record#>>'{outcome,stage}'='before-dispatch') IS DISTINCT FROM (previous_kind='accepted-undispatched') THEN
        RAISE EXCEPTION 'Turn journal failure stage invalid' USING ERRCODE = '23514';
      END IF;
    ELSE
      RAISE EXCEPTION 'Turn journal attempt cannot return to dispatch' USING ERRCODE = '23514';
    END IF;
  END IF;
  IF next_kind IN ('consumed','running','completed') AND NEW.record->'consumption' IS NOT DISTINCT FROM 'null'::jsonb THEN
    RAISE EXCEPTION 'Turn journal consumption required' USING ERRCODE = '23514';
  END IF;
  IF NEW.record->'consumption' IS DISTINCT FROM 'null'::jsonb THEN
    IF (NEW.record#>'{consumption,operation,attempt}') IS DISTINCT FROM exact_attempt
      OR (next_kind='consumed' AND ((NEW.record#>>'{outcome,consumptionOperationRef}') IS DISTINCT FROM (NEW.record#>>'{consumption,operation,operationRef}')
        OR (NEW.record#>>'{outcome,consumedAt}') IS DISTINCT FROM (NEW.record#>>'{consumption,consumedAt}'))) THEN
      RAISE EXCEPTION 'Turn journal consumption identity invalid' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER turn_journal_attempt_guard BEFORE INSERT OR UPDATE OR DELETE ON occ.turn_journal_attempts
FOR EACH ROW EXECUTE FUNCTION occ.turn_journal_attempt_guard();
--> statement-breakpoint
CREATE FUNCTION occ.turn_journal_operation_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, occ AS $$
DECLARE
  exact_attempt jsonb;
  current_attempt occ.turn_journal_attempts%ROWTYPE;
  allocation jsonb;
  expected_head jsonb;
BEGIN
  IF TG_OP = 'DELETE' OR (TG_OP = 'UPDATE' AND NEW IS DISTINCT FROM OLD) THEN
    RAISE EXCEPTION 'Turn journal operations are immutable' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'UPDATE' THEN RETURN NEW; END IF;
  exact_attempt := jsonb_build_object('installationRef', NEW.installation_id,
    'namespaceRef', NEW.namespace_id, 'agentRef', NEW.agent_id,
    'conversationRef', NEW.conversation_ref, 'turnRef', NEW.turn_ref,
    'attemptRef', NEW.attempt_ref, 'reservationRef', NEW.reservation_ref);
  SELECT * INTO current_attempt FROM occ.turn_journal_attempts a WHERE
    a.installation_id=NEW.installation_id AND a.namespace_id=NEW.namespace_id AND a.agent_id=NEW.agent_id
    AND a.conversation_ref=NEW.conversation_ref AND a.turn_ref=NEW.turn_ref AND a.attempt_ref=NEW.attempt_ref AND a.reservation_ref=NEW.reservation_ref;
  IF NOT FOUND OR NEW.request->'attempt' IS DISTINCT FROM exact_attempt
    OR (CASE WHEN NEW.operation_kind='release' THEN NEW.request->>'releaseOperationRef'
      ELSE NEW.request->>'operationRef' END) IS DISTINCT FROM NEW.operation_ref THEN
    RAISE EXCEPTION 'Turn journal operation identity mismatch' USING ERRCODE = '23514';
  END IF;
  SELECT o.record->'expectedHead' INTO expected_head FROM occ.turn_journal_owners o WHERE
    o.installation_id=NEW.installation_id AND o.channel_installation_id=current_attempt.channel_installation_id
    AND o.receipt_ref=current_attempt.admission_receipt_ref;
  CASE NEW.operation_kind
    WHEN 'checkpoint-allocation' THEN
      IF NEW.record IS DISTINCT FROM NEW.request OR NEW.request->'expectedHead' IS DISTINCT FROM expected_head
        OR current_attempt.record IS NULL OR current_attempt.record->'consumption' IS NOT DISTINCT FROM 'null'::jsonb THEN
        RAISE EXCEPTION 'Turn journal checkpoint allocation mismatch' USING ERRCODE='23514';
      END IF;
    WHEN 'completion' THEN
      SELECT op.record INTO allocation FROM occ.turn_journal_operations op WHERE op.installation_id=NEW.installation_id
        AND op.namespace_id=NEW.namespace_id AND op.agent_id=NEW.agent_id AND op.conversation_ref=NEW.conversation_ref
        AND op.turn_ref=NEW.turn_ref AND op.attempt_ref=NEW.attempt_ref AND op.reservation_ref=NEW.reservation_ref
        AND op.operation_kind='checkpoint-allocation';
      IF allocation IS NULL OR NEW.record->'operation' IS DISTINCT FROM NEW.request
        OR (NEW.record#>>'{checkpoint,checkpointId}') IS DISTINCT FROM (allocation->>'checkpointId')
        OR (NEW.request->>'checkpointId') IS DISTINCT FROM (allocation->>'checkpointId')
        OR (NEW.request->'expectedCompletionSequence') IS DISTINCT FROM (expected_head->'completionSequence')
        OR (NEW.record->>'outcomeVersion')::numeric <> (NEW.request->>'expectedAttemptVersion')::numeric+1
        OR NOT (NEW.record->'checkpoint' @> exact_attempt)
        OR (NEW.record#>'{head,context}') IS DISTINCT FROM (expected_head->'context')
        OR (NEW.record#>>'{head,completionSequence}')::numeric <> (expected_head->>'completionSequence')::numeric+1
        OR (NEW.record#>>'{head,headVersion}')::numeric <> (expected_head->>'headVersion')::numeric+1
        OR (NEW.record#>>'{head,creationRef}') IS DISTINCT FROM (expected_head->>'creationRef')
        OR (NEW.record#>>'{checkpoint,parentCheckpointId}') IS DISTINCT FROM (expected_head->>'checkpointId')
        OR (NEW.record#>'{pendingDelivery,attempt}') IS DISTINCT FROM exact_attempt
        OR (NEW.record#>>'{pendingDelivery,slot}') IS DISTINCT FROM 'completed-result' THEN
        RAISE EXCEPTION 'Turn journal completion allocation mismatch' USING ERRCODE='23514';
      END IF;
    WHEN 'outcome' THEN
      IF NEW.record IS DISTINCT FROM current_attempt.record
        OR (NEW.record#>'{binding,attempt}') IS DISTINCT FROM exact_attempt OR NEW.record->'outcome' IS DISTINCT FROM NEW.request->'outcome'
        OR (NEW.record->>'version')::numeric <> (NEW.request->>'expectedAttemptVersion')::numeric+1 THEN
        RAISE EXCEPTION 'Turn journal outcome operation mismatch' USING ERRCODE='23514';
      END IF;
    WHEN 'cancellation' THEN
      -- Serialize direct operation INSERT with the canonical attempt even when
      -- the accepting adapter already holds its enclosing Agent owner lock.
      SELECT * INTO current_attempt FROM occ.turn_journal_attempts a WHERE
        a.installation_id=NEW.installation_id AND a.namespace_id=NEW.namespace_id AND a.agent_id=NEW.agent_id
        AND a.conversation_ref=NEW.conversation_ref AND a.turn_ref=NEW.turn_ref
        AND a.attempt_ref=NEW.attempt_ref AND a.reservation_ref=NEW.reservation_ref FOR UPDATE;
      IF EXISTS (SELECT 1 FROM occ.turn_journal_operations op
        WHERE op.installation_id=NEW.installation_id AND op.namespace_id=NEW.namespace_id AND op.agent_id=NEW.agent_id
          AND op.conversation_ref=NEW.conversation_ref AND op.turn_ref=NEW.turn_ref
          AND op.attempt_ref=NEW.attempt_ref AND op.reservation_ref=NEW.reservation_ref
          AND op.operation_kind='cancellation'
          AND (op.request->>'expectedAttemptVersion')::numeric=(NEW.request->>'expectedAttemptVersion')::numeric)
        OR current_attempt.record#>>'{outcome,kind}' IN ('completed','failed','interrupted','cancelled') THEN
        RAISE EXCEPTION 'Turn journal cancellation version is no longer current' USING ERRCODE='23514';
      END IF;
      IF NEW.record->'operation' IS DISTINCT FROM NEW.request
        OR (NEW.record->>'outcome') IS NULL OR (NEW.record->>'outcome') NOT IN ('requested','cancelled-before-dispatch')
        OR (NEW.request->>'expectedAttemptVersion')::numeric <> current_attempt.version
        OR (NEW.request->>'originalPrincipalRef') IS DISTINCT FROM (
          SELECT o.record#>>'{identity,principalRef}' FROM occ.turn_journal_owners o
          WHERE o.installation_id=NEW.installation_id AND o.channel_installation_id=current_attempt.channel_installation_id AND o.receipt_ref=current_attempt.admission_receipt_ref)
        OR ((NEW.record->>'outcome'='cancelled-before-dispatch') IS DISTINCT FROM (current_attempt.record IS NULL)) THEN
        RAISE EXCEPTION 'Turn journal cancellation operation mismatch' USING ERRCODE='23514';
      END IF;
    WHEN 'release' THEN
      IF NEW.record IS DISTINCT FROM NEW.request OR current_attempt.record IS NULL
        OR NEW.request->'reservation' IS DISTINCT FROM current_attempt.reservation
        OR NEW.request->'workspace' IS DISTINCT FROM current_attempt.record#>'{binding,identity,workspace}'
        OR (NEW.request->>'expectedAttemptVersion')::numeric <> current_attempt.version THEN
        RAISE EXCEPTION 'Turn journal release operation mismatch' USING ERRCODE='23514';
      END IF;
    ELSE RAISE EXCEPTION 'Turn journal unknown operation' USING ERRCODE='23514';
  END CASE;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER turn_journal_operation_guard BEFORE INSERT OR UPDATE OR DELETE ON occ.turn_journal_operations
FOR EACH ROW EXECUTE FUNCTION occ.turn_journal_operation_guard();
--> statement-breakpoint
CREATE FUNCTION occ.turn_journal_reservation_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, occ AS $$
BEGIN
  IF TG_OP='UPDATE' THEN
    IF NEW IS DISTINCT FROM OLD THEN RAISE EXCEPTION 'Turn journal reservation owner is immutable' USING ERRCODE='23514'; END IF;
    RETURN NEW;
  END IF;
  IF EXISTS (SELECT 1 FROM occ.turn_journal_operations op WHERE op.installation_id=NEW.installation_id
    AND op.namespace_id=NEW.namespace_id AND op.agent_id=NEW.agent_id AND op.conversation_ref=NEW.conversation_ref
    AND op.turn_ref=NEW.turn_ref AND op.attempt_ref=NEW.attempt_ref AND op.reservation_ref=NEW.reservation_ref AND op.operation_kind='release') THEN
    RAISE EXCEPTION 'Turn journal released reservation cannot be reacquired' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER turn_journal_reservation_guard BEFORE INSERT OR UPDATE ON occ.turn_journal_reservations
FOR EACH ROW EXECUTE FUNCTION occ.turn_journal_reservation_guard();
--> statement-breakpoint
CREATE FUNCTION occ.turn_journal_reservation_release_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, occ AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM occ.turn_journal_operations op WHERE op.installation_id=OLD.installation_id
    AND op.namespace_id=OLD.namespace_id AND op.agent_id=OLD.agent_id AND op.conversation_ref=OLD.conversation_ref
    AND op.turn_ref=OLD.turn_ref AND op.attempt_ref=OLD.attempt_ref AND op.reservation_ref=OLD.reservation_ref AND op.operation_kind='release') THEN
    RAISE EXCEPTION 'Turn journal reservation release evidence absent' USING ERRCODE='23514';
  END IF;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER turn_journal_reservation_release_guard AFTER DELETE ON occ.turn_journal_reservations
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION occ.turn_journal_reservation_release_guard();
--> statement-breakpoint
CREATE FUNCTION occ.turn_journal_head_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, occ AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Turn journal head cannot be deleted' USING ERRCODE='23514'; END IF;
  IF TG_OP='INSERT' THEN
    IF (NEW.record->>'completionSequence') IS DISTINCT FROM '0' OR (NEW.record->>'headVersion') IS DISTINCT FROM '1' THEN
      RAISE EXCEPTION 'Turn journal head must start at exact creation' USING ERRCODE='23514';
    END IF;
  ELSIF NEW IS DISTINCT FROM OLD THEN
    IF (to_jsonb(NEW)-'record'-'checkpoint') IS DISTINCT FROM (to_jsonb(OLD)-'record'-'checkpoint')
      OR NEW.record->'context' IS DISTINCT FROM OLD.record->'context'
      OR NEW.record->'creationRef' IS DISTINCT FROM OLD.record->'creationRef'
      OR (NEW.record->>'completionSequence')::numeric <> (OLD.record->>'completionSequence')::numeric+1
      OR (NEW.record->>'headVersion')::numeric <> (OLD.record->>'headVersion')::numeric+1 THEN
      RAISE EXCEPTION 'Turn journal head compare-and-set mismatch' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER turn_journal_head_guard BEFORE INSERT OR UPDATE OR DELETE ON occ.turn_journal_heads
FOR EACH ROW EXECUTE FUNCTION occ.turn_journal_head_guard();
--> statement-breakpoint
CREATE FUNCTION occ.turn_journal_completion_atomic_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, occ AS $$
DECLARE completed jsonb;
BEGIN
  IF TG_TABLE_NAME='turn_journal_heads' THEN
    IF NEW.record->>'completionSequence'='0' THEN
      IF NOT EXISTS (SELECT 1 FROM occ.turn_journal_owners o WHERE o.installation_id=NEW.installation_id
        AND o.owner_kind='admission' AND o.record#>>'{decision,kind}'='accepted'
        AND o.record->'expectedHead'=NEW.record) THEN
        RAISE EXCEPTION 'Turn journal creation head admission absent' USING ERRCODE='23514';
      END IF;
      RETURN NULL;
    END IF;
    SELECT op.record INTO completed FROM occ.turn_journal_operations op WHERE op.installation_id=NEW.installation_id
      AND op.namespace_id=NEW.namespace_id AND op.agent_id=NEW.agent_id AND op.conversation_ref=NEW.conversation_ref
      AND op.operation_kind='completion' AND op.record->'head'=NEW.record AND op.record->'checkpoint'=NEW.checkpoint;
  ELSIF TG_TABLE_NAME='turn_journal_attempts' THEN
    IF NEW.record IS NULL THEN RETURN NULL; END IF;
    IF TG_OP='UPDATE' AND OLD.record IS NOT NULL AND NEW.version=OLD.version+1
      AND (NEW.record-'version') IS NOT DISTINCT FROM (OLD.record-'version')
      AND NEW.record->'version' IS NOT DISTINCT FROM to_jsonb(NEW.version)
      AND EXISTS (SELECT 1 FROM occ.turn_journal_operations op
        WHERE op.installation_id=NEW.installation_id AND op.namespace_id=NEW.namespace_id AND op.agent_id=NEW.agent_id
          AND op.conversation_ref=NEW.conversation_ref AND op.turn_ref=NEW.turn_ref
          AND op.attempt_ref=NEW.attempt_ref AND op.reservation_ref=NEW.reservation_ref
          AND op.operation_kind='cancellation' AND op.record->>'outcome'='requested'
          AND (op.request->>'expectedAttemptVersion')::numeric=OLD.version) THEN
      RETURN NULL;
    END IF;
    IF NEW.record#>>'{outcome,kind}' IN ('running','failed','interrupted','outcome-unknown','cancelled') THEN
      IF NOT EXISTS (SELECT 1 FROM occ.turn_journal_operations op WHERE op.installation_id=NEW.installation_id
        AND op.namespace_id=NEW.namespace_id AND op.agent_id=NEW.agent_id AND op.conversation_ref=NEW.conversation_ref
        AND op.turn_ref=NEW.turn_ref AND op.attempt_ref=NEW.attempt_ref AND op.reservation_ref=NEW.reservation_ref
        AND op.operation_kind='outcome' AND op.record=NEW.record) THEN
        RAISE EXCEPTION 'Turn journal outcome transition operation absent' USING ERRCODE='23514';
      END IF;
      RETURN NULL;
    END IF;
    IF NEW.record#>>'{outcome,kind}' <> 'completed' THEN RETURN NULL; END IF;
    SELECT op.record INTO completed FROM occ.turn_journal_operations op WHERE op.installation_id=NEW.installation_id
      AND op.namespace_id=NEW.namespace_id AND op.agent_id=NEW.agent_id AND op.conversation_ref=NEW.conversation_ref
      AND op.turn_ref=NEW.turn_ref AND op.attempt_ref=NEW.attempt_ref AND op.reservation_ref=NEW.reservation_ref
      AND op.operation_kind='completion' AND op.operation_ref=NEW.record#>>'{outcome,completionOperationRef}'
      AND op.record->'checkpoint'=NEW.record#>'{outcome,checkpoint}' AND op.record->'outcomeVersion'=NEW.record->'version';
  ELSE
    IF NEW.operation_kind='cancellation' THEN
      IF NOT EXISTS (SELECT 1 FROM occ.turn_journal_attempts a
        WHERE a.installation_id=NEW.installation_id AND a.namespace_id=NEW.namespace_id AND a.agent_id=NEW.agent_id
          AND a.conversation_ref=NEW.conversation_ref AND a.turn_ref=NEW.turn_ref
          AND a.attempt_ref=NEW.attempt_ref AND a.reservation_ref=NEW.reservation_ref
          AND CASE NEW.record->>'outcome'
            WHEN 'requested' THEN a.record IS NOT NULL
              AND a.version >= (NEW.request->>'expectedAttemptVersion')::numeric+1
            WHEN 'cancelled-before-dispatch' THEN a.record IS NULL AND a.version=1
              AND (NEW.request->>'expectedAttemptVersion')::numeric=1
            ELSE false END) THEN
        RAISE EXCEPTION 'Turn journal cancellation version publication is not atomic' USING ERRCODE='23514';
      END IF;
      RETURN NULL;
    END IF;
    IF NEW.operation_kind <> 'completion' THEN RETURN NULL; END IF;
    completed:=NEW.record;
  END IF;
  IF completed IS NULL OR NOT EXISTS (SELECT 1 FROM occ.turn_journal_attempts a
    WHERE a.installation_id=NEW.installation_id
      AND a.namespace_id=completed#>>'{operation,attempt,namespaceRef}' AND a.agent_id=completed#>>'{operation,attempt,agentRef}'
      AND a.conversation_ref=completed#>>'{operation,attempt,conversationRef}' AND a.turn_ref=completed#>>'{operation,attempt,turnRef}'
      AND a.attempt_ref=completed#>>'{operation,attempt,attemptRef}' AND a.reservation_ref=completed#>>'{operation,attempt,reservationRef}'
      AND a.record#>'{outcome,checkpoint}'=completed->'checkpoint'
      AND a.record#>>'{outcome,kind}'='completed' AND a.record->'version'=completed->'outcomeVersion')
    OR NOT EXISTS (SELECT 1 FROM occ.turn_journal_heads h WHERE h.installation_id=NEW.installation_id
      AND h.namespace_id=completed#>>'{operation,attempt,namespaceRef}' AND h.agent_id=completed#>>'{operation,attempt,agentRef}'
      AND h.conversation_ref=completed#>>'{operation,attempt,conversationRef}'
      AND h.record=completed->'head' AND h.checkpoint=completed->'checkpoint')
    OR NOT EXISTS (SELECT 1 FROM occ.turn_journal_deliveries d WHERE d.installation_id=NEW.installation_id
      AND d.namespace_id=completed#>>'{operation,attempt,namespaceRef}' AND d.agent_id=completed#>>'{operation,attempt,agentRef}'
      AND d.conversation_ref=completed#>>'{operation,attempt,conversationRef}' AND d.turn_ref=completed#>>'{operation,attempt,turnRef}'
      AND d.attempt_ref=completed#>>'{operation,attempt,attemptRef}' AND d.reservation_ref=completed#>>'{operation,attempt,reservationRef}'
      AND d.operation=completed->'pendingDelivery') THEN
    RAISE EXCEPTION 'Turn journal completion publication is not atomic' USING ERRCODE='23514';
  END IF;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER turn_journal_head_atomic AFTER INSERT OR UPDATE ON occ.turn_journal_heads
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION occ.turn_journal_completion_atomic_guard();
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER turn_journal_attempt_atomic AFTER INSERT OR UPDATE ON occ.turn_journal_attempts
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION occ.turn_journal_completion_atomic_guard();
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER turn_journal_completion_atomic AFTER INSERT ON occ.turn_journal_operations
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION occ.turn_journal_completion_atomic_guard();

--> statement-breakpoint
-- Main slots retain the create count across their optional known-ID status update.
-- Native attempt history gives the update its own operation and attempt number 1.
-- Deferred reconciliation permits slot/history writes in either order in one UoW.

CREATE OR REPLACE FUNCTION occ.turn_journal_delivery_value_matches(row_value jsonb)
RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, occ AS $$
  SELECT (
    row_value->'operation'->'attempt' = jsonb_build_object(
      'installationRef', row_value->'installation_id',
      'namespaceRef', row_value->'namespace_id',
      'agentRef', row_value->'agent_id',
      'conversationRef', row_value->'conversation_ref',
      'turnRef', row_value->'turn_ref',
      'attemptRef', row_value->'attempt_ref',
      'reservationRef', row_value->'reservation_ref')
    AND row_value->'operation'->>'operationRef' = row_value->>'operation_ref'
    AND row_value->'operation'->>'slot' = row_value->>'slot'
    AND row_value->'operation'#>>'{operation,kind}' IN ('create', 'update')
    AND (row_value->'outcome' = 'null'::jsonb OR (
      row_value->'outcome'->'operation' = row_value->'operation'
      AND row_value->'outcome'->>'deliveryAttemptRef' = row_value->>'delivery_attempt_ref'
      AND row_value->'outcome'#>>'{outcome,kind}' IN
        ('delivered', 'definitive-no-effect', 'delivery-unknown', 'suppressed')
    ))
  ) IS TRUE;
$$;

CREATE OR REPLACE FUNCTION occ.turn_journal_delivery_slot_transition()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, occ AS $$
DECLARE
  now_at timestamptz := clock_timestamp();
  reserving boolean := false;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Immutable turn journal delivery slot' USING ERRCODE = '23514';
  END IF;
  IF NOT occ.turn_journal_delivery_value_matches(to_jsonb(NEW)) THEN
    RAISE EXCEPTION 'Turn journal delivery value mismatch' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.operation #>> '{operation,kind}' IS DISTINCT FROM 'create'
      OR NEW.update_used OR NEW.attempt_number NOT IN (0, 1)
      OR NEW.outcome IS NOT NULL THEN
      RAISE EXCEPTION 'Invalid initial turn journal delivery slot' USING ERRCODE = '23514';
    END IF;
    reserving := NEW.attempt_number = 1;
  ELSE
    IF to_jsonb(NEW) - ARRAY['operation_ref','operation','delivery_attempt_ref',
         'attempt_number','episode_started_at','outcome','update_used']
       IS DISTINCT FROM
       to_jsonb(OLD) - ARRAY['operation_ref','operation','delivery_attempt_ref',
         'attempt_number','episode_started_at','outcome','update_used'] THEN
      RAISE EXCEPTION 'Turn journal delivery slot cannot be retargeted' USING ERRCODE = '23514';
    END IF;
    IF NEW IS NOT DISTINCT FROM OLD THEN RETURN NEW; END IF;
    IF OLD.episode_started_at IS NOT NULL
      AND NEW.episode_started_at IS DISTINCT FROM OLD.episode_started_at THEN
      RAISE EXCEPTION 'Turn journal delivery episode is immutable' USING ERRCODE = '23514';
    END IF;
    IF OLD.update_used AND NOT NEW.update_used THEN
      RAISE EXCEPTION 'Turn journal delivery update budget is sticky' USING ERRCODE = '23514';
    END IF;
    IF NEW.operation IS DISTINCT FROM OLD.operation
      OR NEW.operation_ref IS DISTINCT FROM OLD.operation_ref THEN
      -- This is the sole operation replacement permitted in a slot. An exact
      -- prior delivered ID is required; ambiguous creates cannot become updates.
      IF OLD.slot <> 'outcome-status' OR OLD.update_used OR NOT NEW.update_used
        OR OLD.operation #>> '{operation,kind}' IS DISTINCT FROM 'create'
        OR NEW.operation #>> '{operation,kind}' IS DISTINCT FROM 'update'
        OR NEW.operation_ref = OLD.operation_ref
        OR OLD.outcome #>> '{outcome,kind}' IS DISTINCT FROM 'delivered'
        OR OLD.outcome #>> '{outcome,providerMessageRef}' IS NULL
        OR NEW.operation #>> '{operation,providerMessageRef}' IS DISTINCT FROM
           OLD.outcome #>> '{outcome,providerMessageRef}'
        OR NEW.operation - ARRAY['operationRef','outputRef','outputDigest','outcomeVersion','operation']
           IS DISTINCT FROM
           OLD.operation - ARRAY['operationRef','outputRef','outputDigest','outcomeVersion','operation']
        OR NEW.attempt_number IS DISTINCT FROM OLD.attempt_number
        OR NEW.delivery_attempt_ref IS NULL
        OR NEW.delivery_attempt_ref IS NOT DISTINCT FROM OLD.delivery_attempt_ref
        OR NEW.outcome IS NOT NULL THEN
        RAISE EXCEPTION 'Invalid turn journal known-ID status update' USING ERRCODE = '23514';
      END IF;
      reserving := true;
    ELSIF NEW.delivery_attempt_ref IS DISTINCT FROM OLD.delivery_attempt_ref THEN
      IF OLD.operation #>> '{operation,kind}' IS DISTINCT FROM 'create'
        OR NEW.update_used IS DISTINCT FROM OLD.update_used OR OLD.update_used
        OR NEW.attempt_number <> OLD.attempt_number + 1
        OR NEW.attempt_number > 3 OR NEW.delivery_attempt_ref IS NULL
        OR NEW.outcome IS NOT NULL
        OR (OLD.attempt_number > 0 AND (
          OLD.outcome #>> '{outcome,kind}' IS DISTINCT FROM 'definitive-no-effect'
          OR OLD.outcome #>> '{outcome,retryClass}' IS DISTINCT FROM 'transient')) THEN
        RAISE EXCEPTION 'Invalid turn journal delivery retry' USING ERRCODE = '23514';
      END IF;
      reserving := true;
    ELSE
      IF NEW.attempt_number IS DISTINCT FROM OLD.attempt_number
        OR NEW.update_used IS DISTINCT FROM OLD.update_used
        OR NEW.episode_started_at IS DISTINCT FROM OLD.episode_started_at
        OR OLD.outcome IS NOT NULL OR NEW.outcome IS NULL
        OR OLD.delivery_attempt_ref IS NULL THEN
        RAISE EXCEPTION 'Turn journal delivery outcome is immutable' USING ERRCODE = '23514';
      END IF;
    END IF;
  END IF;
  IF reserving AND (NEW.episode_started_at IS NULL
    OR NOT isfinite(NEW.episode_started_at)
    OR NEW.episode_started_at > now_at
    OR now_at >= NEW.episode_started_at + interval '120 seconds') THEN
    RAISE EXCEPTION 'Turn journal delivery episode is expired' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER turn_journal_deliveries_transition
BEFORE INSERT OR UPDATE OR DELETE ON occ.turn_journal_deliveries
FOR EACH ROW EXECUTE FUNCTION occ.turn_journal_delivery_slot_transition();

CREATE OR REPLACE FUNCTION occ.turn_journal_delivery_history_transition()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, occ AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Immutable turn journal delivery history' USING ERRCODE = '23514';
  END IF;
  IF NOT occ.turn_journal_delivery_value_matches(to_jsonb(NEW)) THEN
    RAISE EXCEPTION 'Turn journal delivery history value mismatch' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.outcome IS NOT NULL THEN
      RAISE EXCEPTION 'Turn journal delivery history must begin pending' USING ERRCODE = '23514';
    END IF;
  ELSE
    IF NEW IS NOT DISTINCT FROM OLD THEN RETURN NEW; END IF;
    IF to_jsonb(NEW) - 'outcome' IS DISTINCT FROM to_jsonb(OLD) - 'outcome'
      OR OLD.outcome IS NOT NULL OR NEW.outcome IS NULL THEN
      RAISE EXCEPTION 'Turn journal delivery history is immutable' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER turn_journal_delivery_attempts_transition
BEFORE INSERT OR UPDATE OR DELETE ON occ.turn_journal_delivery_attempts
FOR EACH ROW EXECUTE FUNCTION occ.turn_journal_delivery_history_transition();

CREATE OR REPLACE FUNCTION occ.turn_journal_delivery_history_complete()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, occ AS $$
DECLARE
  slot_row occ.turn_journal_deliveries%ROWTYPE;
  history_row occ.turn_journal_delivery_attempts%ROWTYPE;
  create_operation jsonb;
  previous_outcome jsonb;
  last_create_outcome jsonb;
  create_count integer := 0;
  update_count integer := 0;
  current_found boolean := false;
BEGIN
  SELECT * INTO slot_row FROM occ.turn_journal_deliveries
  WHERE installation_id = NEW.installation_id AND namespace_id = NEW.namespace_id
    AND agent_id = NEW.agent_id AND conversation_ref = NEW.conversation_ref
    AND turn_ref = NEW.turn_ref AND attempt_ref = NEW.attempt_ref
    AND reservation_ref = NEW.reservation_ref AND slot = NEW.slot;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Turn journal delivery history has no slot' USING ERRCODE = '23514';
  END IF;
  -- Read final transaction state, not the potentially superseded deferred NEW
  -- snapshot. Each update/reserve has already passed its immediate transition.
  FOR history_row IN
    SELECT * FROM occ.turn_journal_delivery_attempts
    WHERE installation_id = slot_row.installation_id AND namespace_id = slot_row.namespace_id
      AND agent_id = slot_row.agent_id AND conversation_ref = slot_row.conversation_ref
      AND turn_ref = slot_row.turn_ref AND attempt_ref = slot_row.attempt_ref
      AND reservation_ref = slot_row.reservation_ref AND slot = slot_row.slot
    ORDER BY CASE WHEN operation #>> '{operation,kind}' = 'create' THEN 0 ELSE 1 END,
      attempt_number
  LOOP
    IF history_row.episode_started_at IS DISTINCT FROM slot_row.episode_started_at THEN
      RAISE EXCEPTION 'Turn journal delivery history episode mismatch' USING ERRCODE = '23514';
    END IF;
    IF history_row.operation #>> '{operation,kind}' = 'create' THEN
      create_count := create_count + 1;
      IF create_count = 1 THEN create_operation := history_row.operation; END IF;
      IF history_row.attempt_number <> create_count
        OR history_row.operation IS DISTINCT FROM create_operation
        OR (create_count > 1 AND (
          previous_outcome #>> '{outcome,kind}' IS DISTINCT FROM 'definitive-no-effect'
          OR previous_outcome #>> '{outcome,retryClass}' IS DISTINCT FROM 'transient')) THEN
        RAISE EXCEPTION 'Turn journal delivery create history mismatch' USING ERRCODE = '23514';
      END IF;
      previous_outcome := history_row.outcome;
      last_create_outcome := history_row.outcome;
    ELSE
      update_count := update_count + 1;
      IF update_count > 1 OR history_row.attempt_number <> 1
        OR history_row.slot <> 'outcome-status' OR NOT slot_row.update_used
        OR history_row.operation IS DISTINCT FROM slot_row.operation
        OR last_create_outcome #>> '{outcome,kind}' IS DISTINCT FROM 'delivered'
        OR last_create_outcome #>> '{outcome,providerMessageRef}' IS NULL
        OR history_row.operation #>> '{operation,providerMessageRef}' IS DISTINCT FROM
           last_create_outcome #>> '{outcome,providerMessageRef}'
        OR history_row.operation - ARRAY['operationRef','outputRef','outputDigest','outcomeVersion','operation']
           IS DISTINCT FROM
           create_operation - ARRAY['operationRef','outputRef','outputDigest','outcomeVersion','operation'] THEN
        RAISE EXCEPTION 'Turn journal delivery update history mismatch' USING ERRCODE = '23514';
      END IF;
    END IF;
    IF history_row.delivery_attempt_ref = slot_row.delivery_attempt_ref THEN
      IF history_row.operation IS DISTINCT FROM slot_row.operation
        OR history_row.operation_ref IS DISTINCT FROM slot_row.operation_ref
        OR history_row.outcome IS DISTINCT FROM slot_row.outcome
        OR history_row.attempt_number <> (CASE WHEN slot_row.update_used THEN 1 ELSE slot_row.attempt_number END) THEN
        RAISE EXCEPTION 'Turn journal current delivery history mismatch' USING ERRCODE = '23514';
      END IF;
      current_found := true;
    END IF;
  END LOOP;
  IF create_count <> slot_row.attempt_number
    OR update_count <> (CASE WHEN slot_row.update_used THEN 1 ELSE 0 END)
    OR (slot_row.attempt_number > 0 AND NOT current_found)
    OR (NOT slot_row.update_used AND slot_row.attempt_number > 0
      AND slot_row.operation IS DISTINCT FROM create_operation) THEN
    RAISE EXCEPTION 'Turn journal delivery reservation history is incomplete' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER turn_journal_deliveries_history_complete
AFTER INSERT OR UPDATE ON occ.turn_journal_deliveries
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION occ.turn_journal_delivery_history_complete();

CREATE CONSTRAINT TRIGGER turn_journal_delivery_attempts_history_complete
AFTER INSERT OR UPDATE ON occ.turn_journal_delivery_attempts
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION occ.turn_journal_delivery_history_complete();

--> statement-breakpoint
GRANT SELECT, INSERT ON occ.turn_journal_owners, occ.turn_journal_keys,
  occ.turn_journal_incoming_links, occ.turn_journal_operations TO occ_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON occ.turn_journal_attempts, occ.turn_journal_heads,
  occ.turn_journal_deliveries, occ.turn_journal_delivery_attempts TO occ_app;
--> statement-breakpoint
GRANT SELECT, INSERT, DELETE ON occ.turn_journal_reservations TO occ_app;
--> statement-breakpoint
REVOKE ALL ON FUNCTION
  occ.turn_journal_admission_immutable(), occ.turn_journal_key_matches_owner(),
  occ.turn_journal_owner_keys_complete(), occ.turn_journal_link_owners_exist(),
  occ.turn_journal_attempt_guard(), occ.turn_journal_operation_guard(),
  occ.turn_journal_reservation_guard(), occ.turn_journal_reservation_release_guard(),
  occ.turn_journal_head_guard(), occ.turn_journal_completion_atomic_guard(),
  occ.turn_journal_delivery_value_matches(jsonb), occ.turn_journal_delivery_slot_transition(),
  occ.turn_journal_delivery_history_transition(), occ.turn_journal_delivery_history_complete()
FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION occ.turn_journal_delivery_value_matches(jsonb) TO occ_app;
