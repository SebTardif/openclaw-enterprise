-- Install the existing five inventory metadata tables. This does not compose
-- accepting authority, protected token custody or a credential audit producer.
CREATE TABLE occ.credential_inventory_records (
  installation_id text NOT NULL REFERENCES occ.installation(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  namespace_id text NOT NULL,
  agent_id text NOT NULL,
  record_ref text NOT NULL,
  inventory_version bigint NOT NULL,
  binding_ref text NOT NULL,
  live boolean NOT NULL,
  unresolved boolean NOT NULL,
  document jsonb NOT NULL,
  CONSTRAINT credential_inventory_records_pk PRIMARY KEY (installation_id, namespace_id, agent_id, record_ref),
  CONSTRAINT credential_inventory_records_agent FOREIGN KEY (namespace_id, agent_id)
    REFERENCES occ.agents(namespace_id, id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT credential_inventory_records_document CHECK (
    jsonb_typeof(document) = 'object' AND octet_length(document::text) BETWEEN 1 AND 131072
  ),
  CONSTRAINT credential_inventory_records_version CHECK (inventory_version BETWEEN 1 AND 9007199254740991),
  CONSTRAINT credential_inventory_records_identity CHECK ((
    document#>>'{issuance,scope,installationId}' = installation_id
    AND document#>>'{issuance,scope,namespaceId}' = namespace_id
    AND document#>>'{issuance,scope,agentId}' = agent_id
    AND document#>>'{target,recordRef}' = record_ref
    AND (document->>'inventoryVersion')::numeric = inventory_version
    AND document#>>'{issuance,binding,bindingRef}' = binding_ref
    AND document->>'state' IN ('reserved','mint-unknown','not-issued','outstanding','resolved-without-token')
    AND unresolved = (document->>'state' IN ('reserved','mint-unknown'))
    AND live = (document->>'state' IN ('reserved','mint-unknown') OR
      (document->>'state' = 'outstanding' AND document#>>'{revocation,state}' NOT IN ('confirmed','expired')))
  ) IS TRUE)
);
--> statement-breakpoint
CREATE INDEX credential_inventory_records_live
ON occ.credential_inventory_records (installation_id, namespace_id, agent_id, binding_ref) WHERE live;
--> statement-breakpoint
CREATE TABLE occ.credential_inventory_operations (
  installation_id text NOT NULL REFERENCES occ.installation(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  namespace_id text NOT NULL,
  agent_id text NOT NULL,
  operation_ref text NOT NULL,
  record_ref text NOT NULL,
  document jsonb NOT NULL,
  CONSTRAINT credential_inventory_operations_pk PRIMARY KEY (installation_id, operation_ref),
  CONSTRAINT credential_inventory_operations_record FOREIGN KEY (installation_id, namespace_id, agent_id, record_ref)
    REFERENCES occ.credential_inventory_records(installation_id, namespace_id, agent_id, record_ref) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT credential_inventory_operations_document CHECK (
    jsonb_typeof(document) = 'object' AND octet_length(document::text) BETWEEN 1 AND 131072
  ),
  CONSTRAINT credential_inventory_operations_identity CHECK ((
    document#>>'{input,operationRef}' = operation_ref
    AND document#>>'{input,scope,installationId}' = installation_id
    AND document#>>'{input,scope,namespaceId}' = namespace_id
    AND document#>>'{input,scope,agentId}' = agent_id
    AND document#>>'{record,target,recordRef}' = record_ref
    AND document->>'digest' ~ '^sha256:[0-9a-f]{64}$'
    AND document->>'state' IN ('intent-recorded','effect-pending','effect-unknown','completed')
    AND NOT (document ? 'originalReceipt')
  ) IS TRUE)
);
--> statement-breakpoint
CREATE TABLE occ.credential_inventory_mint_claims (
  installation_id text NOT NULL REFERENCES occ.installation(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  namespace_id text NOT NULL,
  agent_id text NOT NULL,
  record_ref text NOT NULL,
  use_operation_ref text NOT NULL,
  provider_attempt_ref text NOT NULL,
  document jsonb NOT NULL,
  CONSTRAINT credential_inventory_mint_claims_pk PRIMARY KEY (installation_id, namespace_id, agent_id, record_ref),
  CONSTRAINT credential_inventory_mint_claims_record FOREIGN KEY (installation_id, namespace_id, agent_id, record_ref)
    REFERENCES occ.credential_inventory_records(installation_id, namespace_id, agent_id, record_ref) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT credential_inventory_mint_claims_use UNIQUE (installation_id, use_operation_ref),
  CONSTRAINT credential_inventory_mint_claims_attempt UNIQUE (installation_id, provider_attempt_ref),
  CONSTRAINT credential_inventory_mint_claims_document CHECK (
    jsonb_typeof(document) = 'object' AND octet_length(document::text) BETWEEN 1 AND 131072
  ),
  CONSTRAINT credential_inventory_mint_claims_identity CHECK ((
    document->>'recordRef' = record_ref
    AND document->>'useOperationRef' = use_operation_ref
    AND document->>'providerAttemptRef' = provider_attempt_ref
    AND document->>'issuanceIntentDigest' ~ '^sha256:[0-9a-f]{64}$'
    AND document->>'useIntentDigest' ~ '^sha256:[0-9a-f]{64}$'
    AND (document->>'inventoryVersion')::numeric BETWEEN 1 AND 9007199254740991
  ) IS TRUE)
);
--> statement-breakpoint
CREATE TABLE occ.credential_inventory_revocation_claims (
  installation_id text NOT NULL REFERENCES occ.installation(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  namespace_id text NOT NULL,
  agent_id text NOT NULL,
  claim_ref text NOT NULL,
  claim_version bigint NOT NULL,
  record_ref text NOT NULL,
  document jsonb NOT NULL,
  CONSTRAINT credential_inventory_revocation_claims_pk PRIMARY KEY (installation_id, namespace_id, agent_id, claim_ref),
  CONSTRAINT credential_inventory_revocation_claims_record FOREIGN KEY (installation_id, namespace_id, agent_id, record_ref)
    REFERENCES occ.credential_inventory_records(installation_id, namespace_id, agent_id, record_ref) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT credential_inventory_revocation_claims_version UNIQUE (installation_id, namespace_id, agent_id, record_ref, claim_version),
  CONSTRAINT credential_inventory_revocation_claims_version_bound CHECK (claim_version BETWEEN 1 AND 9007199254740991),
  CONSTRAINT credential_inventory_revocation_claims_document CHECK (
    jsonb_typeof(document) = 'object' AND octet_length(document::text) BETWEEN 1 AND 131072
  ),
  CONSTRAINT credential_inventory_revocation_claims_identity CHECK ((
    document->>'claimRef' = claim_ref
    AND (document->>'claimVersion')::numeric = claim_version
    AND document#>>'{input,target,recordRef}' = record_ref
    AND document#>>'{input,scope,installationId}' = installation_id
    AND document#>>'{input,scope,namespaceId}' = namespace_id
    AND document#>>'{input,scope,agentId}' = agent_id
  ) IS TRUE)
);
--> statement-breakpoint
CREATE TABLE occ.credential_inventory_snapshots (
  installation_id text NOT NULL REFERENCES occ.installation(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  namespace_id text NOT NULL,
  agent_id text NOT NULL,
  snapshot_ref text NOT NULL,
  snapshot_version bigint NOT NULL,
  document jsonb NOT NULL,
  CONSTRAINT credential_inventory_snapshots_pk PRIMARY KEY (installation_id, namespace_id, agent_id, snapshot_ref),
  CONSTRAINT credential_inventory_snapshots_agent FOREIGN KEY (namespace_id, agent_id)
    REFERENCES occ.agents(namespace_id, id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT credential_inventory_snapshots_version CHECK (snapshot_version BETWEEN 1 AND 9007199254740991),
  CONSTRAINT credential_inventory_snapshots_document CHECK (
    jsonb_typeof(document) = 'object' AND octet_length(document::text) BETWEEN 1 AND 131072
  ),
  CONSTRAINT credential_inventory_snapshots_identity CHECK ((
    document->>'snapshotRef' = snapshot_ref
    AND (document->>'snapshotVersion')::numeric = snapshot_version
    AND document#>>'{filter,scope,installationId}' = installation_id
    AND document#>>'{filter,scope,namespaceId}' = namespace_id
    AND document#>>'{filter,scope,agentId}' = agent_id
    AND document->>'filterDigest' ~ '^sha256:[0-9a-f]{64}$'
    AND jsonb_typeof(document->'records') = 'array'
    AND jsonb_array_length(document->'records') BETWEEN 0 AND 4
  ) IS TRUE)
);
--> statement-breakpoint
-- Keep immutable issuance identity and one-step CAS in the database as well as
-- in the repository predicate. This guard authenticates no authority or custody.
CREATE FUNCTION occ.credential_inventory_record_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, occ AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Credential inventory retention is required' USING ERRCODE = '23514';
  ELSIF TG_OP = 'INSERT' THEN
    IF NEW.inventory_version <> 1 OR NEW.document->>'state' <> 'reserved' THEN
      RAISE EXCEPTION 'Credential inventory must start reserved' USING ERRCODE = '23514';
    END IF;
  ELSIF (NEW.installation_id, NEW.namespace_id, NEW.agent_id, NEW.record_ref, NEW.binding_ref)
      IS DISTINCT FROM (OLD.installation_id, OLD.namespace_id, OLD.agent_id, OLD.record_ref, OLD.binding_ref)
    OR NEW.document->'issuance' IS DISTINCT FROM OLD.document->'issuance'
    OR NEW.document->'target' IS DISTINCT FROM OLD.document->'target'
    OR NEW.inventory_version <> OLD.inventory_version + 1 THEN
    RAISE EXCEPTION 'Credential inventory identity or version conflict' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER credential_inventory_record_guard
BEFORE INSERT OR UPDATE OR DELETE ON occ.credential_inventory_records
FOR EACH ROW EXECUTE FUNCTION occ.credential_inventory_record_guard();
--> statement-breakpoint
CREATE TRIGGER credential_inventory_operations_immutable
BEFORE UPDATE OR DELETE ON occ.credential_inventory_operations
FOR EACH ROW EXECUTE FUNCTION occ.reject_row_mutation();
--> statement-breakpoint
CREATE TRIGGER credential_inventory_mint_claims_immutable
BEFORE UPDATE OR DELETE ON occ.credential_inventory_mint_claims
FOR EACH ROW EXECUTE FUNCTION occ.reject_row_mutation();
--> statement-breakpoint
CREATE TRIGGER credential_inventory_revocation_claims_immutable
BEFORE UPDATE OR DELETE ON occ.credential_inventory_revocation_claims
FOR EACH ROW EXECUTE FUNCTION occ.reject_row_mutation();
--> statement-breakpoint
CREATE TRIGGER credential_inventory_snapshots_immutable
BEFORE UPDATE OR DELETE ON occ.credential_inventory_snapshots
FOR EACH ROW EXECUTE FUNCTION occ.reject_row_mutation();
--> statement-breakpoint
REVOKE ALL ON occ.credential_inventory_records, occ.credential_inventory_operations,
  occ.credential_inventory_mint_claims, occ.credential_inventory_revocation_claims,
  occ.credential_inventory_snapshots FROM PUBLIC, occ_app;
--> statement-breakpoint
GRANT SELECT, INSERT ON occ.credential_inventory_records, occ.credential_inventory_operations,
  occ.credential_inventory_mint_claims, occ.credential_inventory_revocation_claims,
  occ.credential_inventory_snapshots TO occ_app;
--> statement-breakpoint
GRANT UPDATE (inventory_version, binding_ref, live, unresolved, document)
ON occ.credential_inventory_records TO occ_app;
--> statement-breakpoint
-- Row locks require an UPDATE privilege. Immutable-table triggers reject actual
-- updates; the grants below do not permit rewriting original observations.
GRANT UPDATE (operation_ref) ON occ.credential_inventory_operations TO occ_app;
--> statement-breakpoint
GRANT UPDATE (record_ref) ON occ.credential_inventory_mint_claims TO occ_app;
--> statement-breakpoint
GRANT UPDATE (claim_ref) ON occ.credential_inventory_revocation_claims TO occ_app;
--> statement-breakpoint
GRANT UPDATE (snapshot_ref) ON occ.credential_inventory_snapshots TO occ_app;
--> statement-breakpoint
REVOKE ALL ON FUNCTION occ.credential_inventory_record_guard() FROM PUBLIC, occ_app;
