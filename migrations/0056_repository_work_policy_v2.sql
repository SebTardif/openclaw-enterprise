-- Repository Work and versioned repository-use policy storage.

CREATE TABLE occ.repository_work_heads_v2 (
  installation_id text NOT NULL REFERENCES occ.installation(id),
  namespace_id text NOT NULL,
  agent_id text NOT NULL,
  revision_ref text NOT NULL,
  work_ref text NOT NULL,
  parent_work_ref text,
  root_work_ref text NOT NULL,
  revision bigint NOT NULL CHECK (revision BETWEEN 1 AND 9007199254740991),
  withdrawal_revision bigint NOT NULL CHECK (withdrawal_revision BETWEEN 0 AND 9007199254740991),
  state text NOT NULL CHECK (state IN ('open','closed')),
  canonical_document text NOT NULL CHECK (octet_length(canonical_document) BETWEEN 1 AND 131072),
  PRIMARY KEY (installation_id,namespace_id,agent_id,revision_ref,work_ref),
  FOREIGN KEY (namespace_id,agent_id) REFERENCES occ.agents(namespace_id,id),
  FOREIGN KEY (installation_id,namespace_id,agent_id,revision_ref,parent_work_ref)
    REFERENCES occ.repository_work_heads_v2(installation_id,namespace_id,agent_id,revision_ref,work_ref),
  CHECK ((parent_work_ref IS NULL) = (work_ref = root_work_ref)),
  CHECK ((jsonb_typeof(canonical_document::jsonb)='object'
    AND canonical_document::jsonb#>>'{scope,installationId}'=installation_id
    AND canonical_document::jsonb#>>'{scope,namespaceId}'=namespace_id
    AND canonical_document::jsonb#>>'{scope,agentId}'=agent_id
    AND canonical_document::jsonb#>>'{scope,revisionRef}'=revision_ref
    AND canonical_document::jsonb->>'workRef'=work_ref
    AND canonical_document::jsonb->>'rootWorkRef'=root_work_ref
    AND (canonical_document::jsonb->>'parentWorkRef') IS NOT DISTINCT FROM parent_work_ref
    AND canonical_document::jsonb->>'revision'=revision::text
    AND canonical_document::jsonb->>'withdrawalRevision'=withdrawal_revision::text
    AND canonical_document::jsonb->>'state'=state) IS TRUE)
);
CREATE TABLE occ.repository_work_operations_v2 (
  installation_id text NOT NULL REFERENCES occ.installation(id),
  namespace_id text NOT NULL,
  agent_id text NOT NULL,
  revision_ref text NOT NULL,
  operation_ref text NOT NULL,
  request_digest text NOT NULL CHECK (request_digest ~ '^sha256:[a-f0-9]{64}$'),
  invocation_ref text NOT NULL,
  commit_ref text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('admission','preparation','dispatch','closure','observation')),
  canonical_document text NOT NULL CHECK (octet_length(canonical_document) BETWEEN 1 AND 131072),
  PRIMARY KEY (installation_id,namespace_id,agent_id,revision_ref,operation_ref),
  FOREIGN KEY (namespace_id,agent_id) REFERENCES occ.agents(namespace_id,id),
  UNIQUE (installation_id,namespace_id,agent_id,revision_ref,operation_ref,commit_ref,kind),
  CHECK ((jsonb_typeof(canonical_document::jsonb)='object'
    AND canonical_document::jsonb#>>'{scope,installationId}'=installation_id
    AND canonical_document::jsonb#>>'{scope,namespaceId}'=namespace_id
    AND canonical_document::jsonb#>>'{scope,agentId}'=agent_id
    AND canonical_document::jsonb#>>'{scope,revisionRef}'=revision_ref
    AND canonical_document::jsonb->>'operationRef'=operation_ref
    AND canonical_document::jsonb->>'requestDigest'=request_digest
    AND canonical_document::jsonb->>'invocationRef'=invocation_ref
    AND canonical_document::jsonb->>'commitRef'=commit_ref
    AND canonical_document::jsonb->>'kind'=kind) IS TRUE)
);
CREATE TABLE occ.repository_work_releases_v2 (
  installation_id text NOT NULL,
  namespace_id text NOT NULL,
  agent_id text NOT NULL,
  revision_ref text NOT NULL,
  operation_ref text NOT NULL,
  preparation_operation_ref text NOT NULL,
  release_ref text NOT NULL,
  receiver_ref text NOT NULL,
  inventory_record_ref text NOT NULL,
  inventory_version bigint NOT NULL CHECK (inventory_version BETWEEN 1 AND 9007199254740991),
  commit_ref text NOT NULL,
  operation_kind text NOT NULL DEFAULT 'dispatch' CHECK (operation_kind='dispatch'),
  canonical_document text NOT NULL CHECK (octet_length(canonical_document) BETWEEN 1 AND 131072),
  PRIMARY KEY (installation_id,namespace_id,agent_id,revision_ref,operation_ref),
  UNIQUE (installation_id,release_ref),
  UNIQUE (installation_id,namespace_id,agent_id,revision_ref,preparation_operation_ref),
  FOREIGN KEY (installation_id,namespace_id,agent_id,revision_ref,operation_ref,commit_ref,operation_kind)
    REFERENCES occ.repository_work_operations_v2(installation_id,namespace_id,agent_id,revision_ref,operation_ref,commit_ref,kind)
    DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (installation_id,namespace_id,agent_id,revision_ref,preparation_operation_ref)
    REFERENCES occ.repository_work_operations_v2(installation_id,namespace_id,agent_id,revision_ref,operation_ref),
  CHECK ((jsonb_typeof(canonical_document::jsonb)='object'
    AND canonical_document::jsonb->>'preparationOperationRef'=preparation_operation_ref
    AND canonical_document::jsonb->>'releaseRef'=release_ref
    AND canonical_document::jsonb->>'receiverRef'=receiver_ref
    AND canonical_document::jsonb->>'inventoryRecordRef'=inventory_record_ref
    AND canonical_document::jsonb->>'inventoryVersion'=inventory_version::text) IS TRUE)
);
CREATE FUNCTION occ.guard_repository_work_v2() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME = 'repository_work_heads_v2' AND TG_OP = 'UPDATE' THEN
    IF OLD.state <> 'open' OR NEW.state <> 'closed'
      OR NEW.revision <> OLD.revision + 1
      OR NEW.withdrawal_revision NOT IN (OLD.withdrawal_revision, OLD.withdrawal_revision + 1)
      OR (to_jsonb(NEW)-ARRAY['revision','withdrawal_revision','state','canonical_document'])
        IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['revision','withdrawal_revision','state','canonical_document'])
      OR (NEW.canonical_document::jsonb-ARRAY['revision','withdrawalRevision','state'])
        IS DISTINCT FROM (OLD.canonical_document::jsonb-ARRAY['revision','withdrawalRevision','state']) THEN
      RAISE EXCEPTION 'Invalid Work closure transition' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'Immutable Work history' USING ERRCODE='23514';
END $$;
CREATE TRIGGER repository_work_heads_v2_guard BEFORE UPDATE OR DELETE ON occ.repository_work_heads_v2
 FOR EACH ROW EXECUTE FUNCTION occ.guard_repository_work_v2();
CREATE TRIGGER repository_work_operations_v2_guard BEFORE UPDATE OR DELETE ON occ.repository_work_operations_v2
 FOR EACH ROW EXECUTE FUNCTION occ.guard_repository_work_v2();
CREATE TRIGGER repository_work_releases_v2_guard BEFORE UPDATE OR DELETE ON occ.repository_work_releases_v2
 FOR EACH ROW EXECUTE FUNCTION occ.guard_repository_work_v2();

--> statement-breakpoint

CREATE TABLE occ.repository_work_policy_versions_v2 (
 installation_id text NOT NULL REFERENCES occ.installation(id),
 namespace_id text NOT NULL,
 agent_id text NOT NULL,
 policy_ref text NOT NULL,
 version bigint NOT NULL CHECK (version BETWEEN 1 AND 9007199254740991),
 status text NOT NULL CHECK (status IN ('enabled','disabled')),
 service_principal_id text NOT NULL,
 repository_id text NOT NULL CHECK (repository_id ~ '^[1-9][0-9]{0,19}$'),
 canonical_document text NOT NULL CHECK (octet_length(canonical_document) BETWEEN 1 AND 131072),
 PRIMARY KEY (installation_id,namespace_id,agent_id,policy_ref,version),
 FOREIGN KEY (namespace_id,agent_id) REFERENCES occ.agents(namespace_id,id),
 UNIQUE (installation_id,namespace_id,agent_id,policy_ref,version,service_principal_id,repository_id),
 CHECK ((jsonb_typeof(canonical_document::jsonb)='object'
  AND canonical_document::jsonb->>'installationId'=installation_id
  AND canonical_document::jsonb->>'namespaceId'=namespace_id
  AND canonical_document::jsonb->>'agentId'=agent_id
  AND canonical_document::jsonb->>'policyRef'=policy_ref
  AND canonical_document::jsonb->>'version'=version::text
  AND canonical_document::jsonb->>'status'=status
  AND canonical_document::jsonb->>'servicePrincipalId'=service_principal_id
  AND canonical_document::jsonb->>'repositoryId'=repository_id) IS TRUE)
);
CREATE TABLE occ.repository_work_policy_heads_v2 (
 installation_id text NOT NULL,
 namespace_id text NOT NULL,
 agent_id text NOT NULL,
 policy_ref text NOT NULL,
 version bigint NOT NULL,
 service_principal_id text NOT NULL,
 repository_id text NOT NULL,
 PRIMARY KEY (installation_id,namespace_id,agent_id,policy_ref),
 UNIQUE (installation_id,namespace_id,agent_id,service_principal_id,repository_id),
 FOREIGN KEY (installation_id,namespace_id,agent_id,policy_ref,version,service_principal_id,repository_id)
  REFERENCES occ.repository_work_policy_versions_v2(installation_id,namespace_id,agent_id,policy_ref,version,service_principal_id,repository_id)
);
CREATE TABLE occ.repository_work_policy_operations_v2 (
 installation_id text NOT NULL,
 namespace_id text NOT NULL,
 agent_id text NOT NULL,
 operation_ref text NOT NULL,
 request_digest text NOT NULL CHECK (request_digest ~ '^sha256:[a-f0-9]{64}$'),
 commit_ref text NOT NULL,
 policy_ref text NOT NULL,
 policy_version bigint NOT NULL,
 canonical_document text NOT NULL CHECK (octet_length(canonical_document) BETWEEN 1 AND 131072),
 PRIMARY KEY (installation_id,namespace_id,agent_id,operation_ref),
 FOREIGN KEY (installation_id,namespace_id,agent_id,policy_ref,policy_version)
  REFERENCES occ.repository_work_policy_versions_v2(installation_id,namespace_id,agent_id,policy_ref,version),
 CHECK ((jsonb_typeof(canonical_document::jsonb)='object'
  AND canonical_document::jsonb->>'operationRef'=operation_ref
  AND canonical_document::jsonb->>'requestDigest'=request_digest
  AND canonical_document::jsonb->>'commitRef'=commit_ref
  AND canonical_document::jsonb#>>'{policy,installationId}'=installation_id
  AND canonical_document::jsonb#>>'{policy,namespaceId}'=namespace_id
  AND canonical_document::jsonb#>>'{policy,agentId}'=agent_id
  AND canonical_document::jsonb#>>'{policy,policyRef}'=policy_ref
  AND canonical_document::jsonb#>>'{policy,version}'=policy_version::text) IS TRUE)
);
CREATE FUNCTION occ.guard_repository_work_policy_v2() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_TABLE_NAME='repository_work_policy_heads_v2' AND TG_OP='UPDATE' THEN
  IF NEW.version <> OLD.version + 1 OR
   (to_jsonb(NEW)-'version') IS DISTINCT FROM (to_jsonb(OLD)-'version') THEN
   RAISE EXCEPTION 'Invalid repository policy head transition' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
 END IF;
 RAISE EXCEPTION 'Immutable repository policy history' USING ERRCODE='23514';
END $$;
CREATE TRIGGER repository_work_policy_heads_v2_guard BEFORE UPDATE OR DELETE ON occ.repository_work_policy_heads_v2
 FOR EACH ROW EXECUTE FUNCTION occ.guard_repository_work_policy_v2();
CREATE TRIGGER repository_work_policy_versions_v2_guard BEFORE UPDATE OR DELETE ON occ.repository_work_policy_versions_v2
 FOR EACH ROW EXECUTE FUNCTION occ.guard_repository_work_policy_v2();
CREATE TRIGGER repository_work_policy_operations_v2_guard BEFORE UPDATE OR DELETE ON occ.repository_work_policy_operations_v2
 FOR EACH ROW EXECUTE FUNCTION occ.guard_repository_work_policy_v2();

--> statement-breakpoint
-- Preserve the existing application role and immutable history boundaries.
REVOKE ALL ON
  occ.repository_work_heads_v2,
  occ.repository_work_operations_v2,
  occ.repository_work_releases_v2,
  occ.repository_work_policy_versions_v2,
  occ.repository_work_policy_heads_v2,
  occ.repository_work_policy_operations_v2
FROM PUBLIC, occ_app;
--> statement-breakpoint
REVOKE ALL ON FUNCTION occ.guard_repository_work_v2(),
  occ.guard_repository_work_policy_v2() FROM PUBLIC, occ_app;
--> statement-breakpoint
GRANT SELECT, INSERT ON
  occ.repository_work_heads_v2,
  occ.repository_work_operations_v2,
  occ.repository_work_releases_v2,
  occ.repository_work_policy_versions_v2,
  occ.repository_work_policy_heads_v2,
  occ.repository_work_policy_operations_v2
TO occ_app;
--> statement-breakpoint
GRANT UPDATE (revision, withdrawal_revision, state, canonical_document)
ON occ.repository_work_heads_v2 TO occ_app;
--> statement-breakpoint
GRANT UPDATE (version) ON occ.repository_work_policy_heads_v2 TO occ_app;
