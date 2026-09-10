-- Extends the existing inventory journal with immutable Work/access-lease metadata.
-- These tables do not authenticate Work, accept authority, or store credentials.
CREATE TABLE occ.credential_inventory_access_leases (
  installation_id text NOT NULL REFERENCES occ.installation(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  namespace_id text NOT NULL,
  agent_id text NOT NULL,
  access_lease_ref text NOT NULL,
  stable_target_digest text NOT NULL,
  document jsonb NOT NULL,
  CONSTRAINT credential_inventory_access_leases_pk PRIMARY KEY (installation_id, access_lease_ref),
  CONSTRAINT credential_inventory_access_leases_agent FOREIGN KEY (namespace_id, agent_id)
    REFERENCES occ.agents(namespace_id, id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT credential_inventory_access_leases_identity_tuple
    UNIQUE (installation_id, namespace_id, agent_id, access_lease_ref, stable_target_digest),
  CONSTRAINT credential_inventory_access_leases_document CHECK (
    jsonb_typeof(document) = 'object' AND octet_length(document::text) BETWEEN 1 AND 131072
  ),
  CONSTRAINT credential_inventory_access_leases_identity CHECK ((
          document->>'schemaVersion' = '2'
          AND document->>'accessLeaseRef' = access_lease_ref
          AND document#>>'{original,scope,installationRef}' = installation_id
          AND document#>>'{original,scope,namespaceRef}' = namespace_id
          AND document#>>'{original,scope,agentRef}' = agent_id
          AND length(document#>>'{original,scope,revisionRef}') > 0
          AND document#>>'{target,installationId}' = installation_id
          AND document#>>'{target,githubHost}' = 'github.com'
          AND document#>>'{target,installationId}' ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]*$'
          AND document#>>'{target,appId}' ~ '^[1-9][0-9]{0,19}$'
          AND document#>>'{target,githubInstallationId}' ~ '^[1-9][0-9]{0,19}$'
          AND document#>>'{target,repositoryId}' ~ '^[1-9][0-9]{0,19}$'
          AND jsonb_typeof(document->'work') = 'object'
          AND jsonb_typeof(document->'execution') = 'object'
          AND length(document->>'createdAt') > 0
          AND length(document->>'notAfter') > 0
          AND stable_target_digest ~ '^sha256:[0-9a-f]{64}$'
          AND stable_target_digest = 'sha256:' || encode(sha256(convert_to(
            (document#>>'{target,installationId}') || E'\n' ||
            (document#>>'{target,githubHost}') || E'\n' ||
            (document#>>'{target,appId}') || E'\n' ||
            (document#>>'{target,githubInstallationId}') || E'\n' ||
            (document#>>'{target,repositoryId}'), 'UTF8')), 'hex')
        ) IS TRUE)
);
--> statement-breakpoint
CREATE TRIGGER credential_inventory_access_leases_immutable
BEFORE UPDATE OR DELETE ON occ.credential_inventory_access_leases
FOR EACH ROW EXECUTE FUNCTION occ.reject_row_mutation();
--> statement-breakpoint
ALTER TABLE occ.credential_inventory_records
  ADD COLUMN schema_version integer NOT NULL DEFAULT 1,
  ADD COLUMN stable_target_digest text,
  ADD COLUMN access_lease_ref text,
  ADD COLUMN live_slot smallint,
  ADD COLUMN mint_active boolean NOT NULL DEFAULT false,
  ADD COLUMN target_held boolean NOT NULL DEFAULT false,
  DROP CONSTRAINT credential_inventory_records_identity,
  ADD CONSTRAINT credential_inventory_records_identity CHECK ((
      document#>>'{issuance,scope,installationId}' = installation_id
      AND document#>>'{issuance,scope,namespaceId}' = namespace_id
      AND document#>>'{issuance,scope,agentId}' = agent_id
      AND document#>>'{target,recordRef}' = record_ref
      AND (document->>'inventoryVersion')::numeric = inventory_version
      AND (
        (schema_version = 1
          AND document->>'schemaVersion' = '1'
          AND document#>>'{issuance,binding,bindingRef}' = binding_ref
          AND stable_target_digest IS NULL AND access_lease_ref IS NULL
          AND live_slot IS NULL AND NOT mint_active AND NOT target_held)
        OR (schema_version = 2
          AND document->>'schemaVersion' = '2'
          AND document#>>'{issuance,bindingRef}' = binding_ref
          AND document#>>'{issuance,lease,accessLeaseRef}' = access_lease_ref
          AND access_lease_ref IS NOT NULL
          AND stable_target_digest ~ '^sha256:[0-9a-f]{64}$'
          AND ((live AND live_slot IN (1, 2))
            OR (NOT live AND live_slot IS NULL))
          AND mint_active = (document->>'state' IN ('reserved','mint-unknown'))
          AND target_held = (document->>'state' = 'mint-unknown'
            OR (document->>'state' = 'outstanding'
              AND document->>'disposition' = 'mitigation-only')))
      )
      AND document->>'state' IN ('reserved','mint-unknown','not-issued','outstanding','resolved-without-token')
      AND unresolved = (document->>'state' IN ('reserved','mint-unknown'))
      AND live = (document->>'state' IN ('reserved','mint-unknown') OR
        (document->>'state' = 'outstanding' AND (
          schema_version = 2 OR (schema_version = 1
            AND document#>>'{revocation,state}' NOT IN ('confirmed','expired')))))
    ) IS TRUE),
  ADD CONSTRAINT credential_inventory_records_access_lease
    FOREIGN KEY (installation_id, namespace_id, agent_id, access_lease_ref, stable_target_digest)
    REFERENCES occ.credential_inventory_access_leases
      (installation_id, namespace_id, agent_id, access_lease_ref, stable_target_digest)
    ON UPDATE RESTRICT ON DELETE RESTRICT;
--> statement-breakpoint
CREATE UNIQUE INDEX credential_inventory_records_lease_live_slot
ON occ.credential_inventory_records (installation_id, access_lease_ref, live_slot)
WHERE schema_version = 2 AND live;
--> statement-breakpoint
CREATE UNIQUE INDEX credential_inventory_records_lease_active_mint
ON occ.credential_inventory_records (installation_id, access_lease_ref)
WHERE schema_version = 2 AND mint_active;
--> statement-breakpoint
CREATE INDEX credential_inventory_records_target_hold
ON occ.credential_inventory_records (installation_id, stable_target_digest)
WHERE schema_version = 2 AND target_held AND live;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION occ.credential_inventory_record_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, occ AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Credential inventory retention is required' USING ERRCODE = '23514';
  ELSIF TG_OP = 'INSERT' THEN
    IF NEW.inventory_version <> 1 OR NEW.document->>'state' <> 'reserved' THEN
      RAISE EXCEPTION 'Credential inventory must start reserved' USING ERRCODE = '23514';
    END IF;
    IF NEW.schema_version = 2 AND NOT EXISTS (
      SELECT 1 FROM occ.credential_inventory_access_leases AS lease
      WHERE lease.installation_id = NEW.installation_id
        AND lease.namespace_id = NEW.namespace_id
        AND lease.agent_id = NEW.agent_id
        AND lease.access_lease_ref = NEW.access_lease_ref
        AND lease.stable_target_digest = NEW.stable_target_digest
        AND lease.document = NEW.document#>'{issuance,lease}'
    ) THEN
      RAISE EXCEPTION 'Credential inventory lease identity conflict' USING ERRCODE = '23514';
    END IF;
  ELSIF (NEW.installation_id, NEW.namespace_id, NEW.agent_id, NEW.record_ref, NEW.binding_ref, NEW.schema_version, NEW.stable_target_digest, NEW.access_lease_ref)
      IS DISTINCT FROM (OLD.installation_id, OLD.namespace_id, OLD.agent_id, OLD.record_ref, OLD.binding_ref, OLD.schema_version, OLD.stable_target_digest, OLD.access_lease_ref)
    OR NEW.document->'issuance' IS DISTINCT FROM OLD.document->'issuance'
    OR NEW.document->'target' IS DISTINCT FROM OLD.document->'target'
    OR NEW.inventory_version <> OLD.inventory_version + 1 THEN
    RAISE EXCEPTION 'Credential inventory identity or version conflict' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON occ.credential_inventory_access_leases FROM PUBLIC, occ_app;
--> statement-breakpoint
GRANT SELECT, INSERT ON occ.credential_inventory_access_leases TO occ_app;
--> statement-breakpoint
-- Like the existing journal, row locking is allowed while mutation is rejected.
GRANT UPDATE (access_lease_ref) ON occ.credential_inventory_access_leases TO occ_app;
--> statement-breakpoint
GRANT UPDATE (live_slot, mint_active, target_held)
ON occ.credential_inventory_records TO occ_app;
