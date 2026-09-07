-- Retain manual account provisioning, credential changes and deletion state.
-- Account writers and security readers share one transaction lock protocol.
-- Existing user/account rows are not backfilled or made active.
BEGIN;
SET LOCAL search_path = pg_catalog, pg_temp;

LOCK TABLE occ."user", occ.account IN ACCESS EXCLUSIVE MODE;

CREATE TABLE occ.account_security_records (
  installation_id text NOT NULL,
  account_id text NOT NULL,
  issuer text NOT NULL,
  subject text NOT NULL,
  incarnation uuid NOT NULL,
  account_version bigint NOT NULL,
  state text NOT NULL,
  current_user_id text,
  credential_account_id text,
  CONSTRAINT account_security_records_pk PRIMARY KEY (installation_id, account_id),
  CONSTRAINT account_security_records_incarnation_unique UNIQUE (incarnation),
  CONSTRAINT account_security_records_current_user_unique UNIQUE (current_user_id),
  CONSTRAINT account_security_records_credential_unique UNIQUE (credential_account_id),
  CONSTRAINT account_security_records_installation_fk FOREIGN KEY (installation_id)
    REFERENCES occ.installation (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT account_security_records_current_user_fk FOREIGN KEY (current_user_id)
    REFERENCES occ."user" (id) ON UPDATE NO ACTION ON DELETE NO ACTION
    DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT account_security_records_credential_fk FOREIGN KEY (credential_account_id)
    REFERENCES occ.account (id) ON UPDATE NO ACTION ON DELETE NO ACTION
    DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT account_security_records_account_id_valid
    CHECK (char_length(account_id) BETWEEN 1 AND 200),
  CONSTRAINT account_security_records_issuer_exact
    CHECK (issuer = 'occ:installation:' || installation_id || ':better-auth'),
  CONSTRAINT account_security_records_subject_exact CHECK (subject = account_id),
  CONSTRAINT account_security_records_version_valid
    CHECK (account_version BETWEEN 1 AND 9007199254740991),
  CONSTRAINT account_security_records_live_user_exact
    CHECK (current_user_id IS NULL OR current_user_id = account_id),
  CONSTRAINT account_security_records_state_shape CHECK (
    (state = 'provisioning' AND current_user_id IS NOT NULL AND credential_account_id IS NULL)
    OR (state = 'active' AND current_user_id IS NOT NULL AND credential_account_id IS NOT NULL)
    OR (state = 'deleted' AND current_user_id IS NULL AND credential_account_id IS NULL)
  )
);

CREATE FUNCTION occ.account_security_installation_v1()
RETURNS text LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  identities text[];
BEGIN
  SELECT pg_catalog.array_agg(i.id) INTO identities FROM occ.installation AS i;
  IF pg_catalog.cardinality(identities) IS DISTINCT FROM 1
    OR identities[1] IS NULL THEN
    RAISE EXCEPTION 'Account security requires the canonical Installation' USING ERRCODE = '55000';
  END IF;
  RETURN identities[1];
END
$function$;

CREATE FUNCTION occ.account_security_writer_gate_v1()
RETURNS trigger LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  canonical_installation text;
BEGIN
  IF TG_LEVEL <> 'STATEMENT' OR TG_WHEN <> 'BEFORE' OR TG_TABLE_SCHEMA <> 'occ'
    OR TG_TABLE_NAME NOT IN ('user', 'account') OR TG_OP NOT IN ('INSERT', 'UPDATE', 'DELETE') THEN
    RAISE EXCEPTION 'Unsupported account security writer' USING ERRCODE = '55000';
  END IF;
  canonical_installation := occ.account_security_installation_v1();
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('native-account-security-v1:' || canonical_installation, 0)
  );
  IF occ.account_security_installation_v1() IS DISTINCT FROM canonical_installation THEN
    RAISE EXCEPTION 'Account security Installation changed' USING ERRCODE = '55000';
  END IF;
  RETURN NULL;
END
$function$;

CREATE FUNCTION occ.account_security_refuse_truncate_v1()
RETURNS trigger LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
BEGIN
  RAISE EXCEPTION 'Account security does not support truncation' USING ERRCODE = '55000';
END
$function$;

CREATE FUNCTION occ.account_security_record_guard_v1()
RETURNS trigger LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
BEGIN
  IF TG_TABLE_SCHEMA <> 'occ' OR TG_TABLE_NAME <> 'account_security_records'
    OR TG_LEVEL <> 'ROW' OR TG_WHEN <> 'BEFORE' THEN
    RAISE EXCEPTION 'Unsupported account security record writer' USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Account security tombstones are retained' USING ERRCODE = '55000';
  ELSIF TG_OP = 'INSERT' THEN
    IF NEW.state IS DISTINCT FROM 'provisioning'
      OR NEW.account_version IS DISTINCT FROM 1::bigint
      OR NEW.current_user_id IS DISTINCT FROM NEW.account_id
      OR NEW.credential_account_id IS NOT NULL THEN
      RAISE EXCEPTION 'Account security requires original provisioning' USING ERRCODE = '23514';
    END IF;
  ELSIF TG_OP = 'UPDATE' THEN
    IF ROW(NEW.installation_id, NEW.account_id, NEW.issuer, NEW.subject, NEW.incarnation)
      IS DISTINCT FROM ROW(OLD.installation_id, OLD.account_id, OLD.issuer, OLD.subject, OLD.incarnation)
      OR OLD.state = 'deleted'
      OR OLD.account_version >= 9007199254740991
      OR NEW.account_version IS DISTINCT FROM OLD.account_version + 1 THEN
      RAISE EXCEPTION 'Account security identity or version is immutable' USING ERRCODE = '23514';
    END IF;
    IF OLD.state = 'active' AND NEW.state = 'active'
      AND NEW.credential_account_id IS DISTINCT FROM OLD.credential_account_id THEN
      RAISE EXCEPTION 'Account security credential cannot be retargeted' USING ERRCODE = '23514';
    END IF;
  ELSE
    RAISE EXCEPTION 'Unsupported account security record operation' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END
$function$;

CREATE FUNCTION occ.account_security_user_write_v1()
RETURNS trigger LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  canonical_installation text;
  held occ.account_security_records%ROWTYPE;
BEGIN
  IF TG_LEVEL <> 'ROW' OR TG_TABLE_SCHEMA <> 'occ' OR TG_TABLE_NAME <> 'user'
    OR (TG_OP IN ('INSERT', 'UPDATE') AND TG_WHEN <> 'AFTER')
    OR (TG_OP = 'DELETE' AND TG_WHEN <> 'BEFORE')
    OR TG_OP NOT IN ('INSERT', 'UPDATE', 'DELETE') THEN
    RAISE EXCEPTION 'Unsupported account security user writer' USING ERRCODE = '55000';
  END IF;
  canonical_installation := occ.account_security_installation_v1();
  IF TG_OP = 'INSERT' THEN
    -- AFTER ROW: a conflicting INSERT that did nothing cannot establish a record.
    -- The primary key intentionally rejects reuse of a tombstoned user identity.
    INSERT INTO occ.account_security_records
      (installation_id, account_id, issuer, subject, incarnation, account_version,
       state, current_user_id, credential_account_id)
    VALUES
      (canonical_installation, NEW.id,
       'occ:installation:' || canonical_installation || ':better-auth', NEW.id,
       pg_catalog.gen_random_uuid(), 1, 'provisioning', NEW.id, NULL);
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW.id IS DISTINCT FROM OLD.id THEN
      RAISE EXCEPTION 'Account security user identity cannot be retargeted' USING ERRCODE = '23514';
    END IF;
  END IF;
  SELECT r.* INTO held FROM occ.account_security_records AS r
    WHERE r.installation_id = canonical_installation AND r.account_id = OLD.id
    FOR UPDATE;
  IF NOT FOUND OR held.state NOT IN ('provisioning', 'active')
    OR held.current_user_id IS DISTINCT FROM OLD.id THEN
    RAISE EXCEPTION 'Managed account security record unavailable' USING ERRCODE = '55000';
  END IF;
  IF held.account_version >= 9007199254740991 THEN
    RAISE EXCEPTION 'Account security version exhausted' USING ERRCODE = '22003';
  END IF;
  IF TG_OP = 'DELETE' THEN
    -- This precedes PostgreSQL's child cascade. The dependency's explicit
    -- account-delete-first route already moved active to provisioning.
    UPDATE occ.account_security_records AS r
      SET state = 'deleted', current_user_id = NULL, credential_account_id = NULL,
          account_version = held.account_version + 1
      WHERE r.installation_id = canonical_installation AND r.account_id = OLD.id;
    RETURN OLD;
  END IF;
  -- Conservatively advance for every actual affected managed-user update.
  UPDATE occ.account_security_records AS r SET account_version = held.account_version + 1
    WHERE r.installation_id = canonical_installation AND r.account_id = OLD.id;
  RETURN NEW;
END
$function$;

CREATE FUNCTION occ.account_security_credential_write_v1()
RETURNS trigger LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  canonical_installation text;
  canonical_account text;
  credential_row text;
  held occ.account_security_records%ROWTYPE;
BEGIN
  IF TG_LEVEL <> 'ROW' OR TG_WHEN <> 'AFTER' OR TG_TABLE_SCHEMA <> 'occ'
    OR TG_TABLE_NAME <> 'account' OR TG_OP NOT IN ('INSERT', 'UPDATE', 'DELETE') THEN
    RAISE EXCEPTION 'Unsupported account security credential writer' USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.provider_id <> 'credential' THEN RETURN NEW; END IF;
    IF NEW.account_id IS DISTINCT FROM NEW.user_id OR NEW.password IS NULL OR NEW.password = '' THEN
      RAISE EXCEPTION 'Unsupported local credential association' USING ERRCODE = '23514';
    END IF;
    canonical_account := NEW.user_id;
    credential_row := NEW.id;
  ELSIF TG_OP = 'UPDATE' THEN
    IF OLD.provider_id <> 'credential' AND NEW.provider_id <> 'credential' THEN RETURN NEW; END IF;
    IF ROW(NEW.id, NEW.provider_id, NEW.account_id, NEW.user_id)
      IS DISTINCT FROM ROW(OLD.id, OLD.provider_id, OLD.account_id, OLD.user_id)
      OR NEW.provider_id <> 'credential'
      OR NEW.account_id IS DISTINCT FROM NEW.user_id
      OR OLD.password IS NULL OR OLD.password = ''
      OR NEW.password IS NULL OR NEW.password = '' THEN
      RAISE EXCEPTION 'Local credential identity or password state cannot be retargeted' USING ERRCODE = '23514';
    END IF;
    canonical_account := NEW.user_id;
    credential_row := NEW.id;
  ELSE
    IF OLD.provider_id <> 'credential' THEN RETURN OLD; END IF;
    IF OLD.account_id IS DISTINCT FROM OLD.user_id THEN
      RAISE EXCEPTION 'Unsupported local credential association' USING ERRCODE = '23514';
    END IF;
    canonical_account := OLD.user_id;
    credential_row := OLD.id;
  END IF;
  canonical_installation := occ.account_security_installation_v1();
  SELECT r.* INTO held FROM occ.account_security_records AS r
    WHERE r.installation_id = canonical_installation AND r.account_id = canonical_account
    FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Managed account security record unavailable' USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'DELETE' AND held.state = 'deleted' THEN
    -- Only the already-deleted exact local association under the parent cascade
    -- may finish without another record update. No user row can remain live.
    IF held.current_user_id IS NOT NULL OR held.credential_account_id IS NOT NULL
      OR EXISTS (SELECT 1 FROM occ."user" AS u WHERE u.id = canonical_account) THEN
      RAISE EXCEPTION 'Account security cascade correspondence unavailable' USING ERRCODE = '55000';
    END IF;
    RETURN OLD;
  END IF;
  IF held.current_user_id IS DISTINCT FROM canonical_account
    OR held.account_version >= 9007199254740991
    OR NOT EXISTS (SELECT 1 FROM occ."user" AS u WHERE u.id = canonical_account) THEN
    RAISE EXCEPTION 'Account security current user unavailable' USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF held.state <> 'provisioning' OR held.credential_account_id IS NOT NULL THEN
      RAISE EXCEPTION 'Local credential requires original provisioning' USING ERRCODE = '55000';
    END IF;
    UPDATE occ.account_security_records AS r
      SET state = 'active', credential_account_id = credential_row,
          account_version = held.account_version + 1
      WHERE r.installation_id = canonical_installation AND r.account_id = canonical_account;
    RETURN NEW;
  END IF;
  IF held.state <> 'active' OR held.credential_account_id IS DISTINCT FROM credential_row THEN
    RAISE EXCEPTION 'Exact current local credential unavailable' USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'DELETE' THEN
    -- BetterAuth deleteUser removes account rows in an earlier call. Revoke the
    -- active state here even if its later user deletion never commits.
    UPDATE occ.account_security_records AS r
      SET state = 'provisioning', credential_account_id = NULL,
          account_version = held.account_version + 1
      WHERE r.installation_id = canonical_installation AND r.account_id = canonical_account;
    RETURN OLD;
  END IF;
  UPDATE occ.account_security_records AS r SET account_version = held.account_version + 1
    WHERE r.installation_id = canonical_installation AND r.account_id = canonical_account;
  RETURN NEW;
END
$function$;

CREATE FUNCTION occ.read_locked_account_security_v1(
  p_installation_id text, p_account_id text, p_issuer text, p_subject text
)
RETURNS TABLE (
  installation_id text, account_id text, issuer text, subject text, incarnation uuid,
  account_version text, state text, current_user_id text, credential_account_id text
)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  canonical_installation text;
  held occ.account_security_records%ROWTYPE;
  live_user text;
  credential_count bigint;
  credential_row text;
  credential_user text;
  credential_account text;
  credential_password_present boolean;
BEGIN
  IF pg_catalog.current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'Account security requires READ COMMITTED' USING ERRCODE = '25001';
  END IF;
  canonical_installation := occ.account_security_installation_v1();
  IF p_installation_id IS DISTINCT FROM canonical_installation
    OR p_account_id IS NULL OR char_length(p_account_id) NOT BETWEEN 1 AND 200
    OR p_issuer IS DISTINCT FROM 'occ:installation:' || canonical_installation || ':better-auth'
    OR p_subject IS DISTINCT FROM p_account_id THEN
    RAISE EXCEPTION 'Account security lookup identity mismatch' USING ERRCODE = '23514';
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock_shared(
    pg_catalog.hashtextextended('native-account-security-v1:' || canonical_installation, 0)
  );
  IF occ.account_security_installation_v1() IS DISTINCT FROM canonical_installation THEN
    RAISE EXCEPTION 'Account security Installation changed' USING ERRCODE = '55000';
  END IF;
  -- This query begins after the advisory wait; later parent reads are separate
  -- volatile statements after this row-lock wait as well.
  SELECT r.* INTO held FROM occ.account_security_records AS r
    WHERE r.installation_id = canonical_installation AND r.account_id = p_account_id
    FOR SHARE;
  IF NOT FOUND THEN RETURN; END IF;
  IF held.issuer IS DISTINCT FROM p_issuer OR held.subject IS DISTINCT FROM p_subject THEN
    RAISE EXCEPTION 'Account security retained identity mismatch' USING ERRCODE = '23514';
  END IF;
  SELECT u.id INTO live_user FROM occ."user" AS u WHERE u.id = p_account_id;
  SELECT count(*), min(a.id) INTO credential_count, credential_row
    FROM occ.account AS a WHERE a.provider_id = 'credential'
      AND (a.user_id = p_account_id OR a.account_id = p_account_id);
  IF held.state = 'deleted' THEN
    IF live_user IS NOT NULL OR credential_count <> 0
      OR held.current_user_id IS NOT NULL OR held.credential_account_id IS NOT NULL THEN
      RAISE EXCEPTION 'Deleted account security correspondence unavailable' USING ERRCODE = '55000';
    END IF;
  ELSE
    IF live_user IS DISTINCT FROM p_account_id OR held.current_user_id IS DISTINCT FROM live_user THEN
      RAISE EXCEPTION 'Account security current user unavailable' USING ERRCODE = '55000';
    END IF;
    IF held.state = 'provisioning' THEN
      IF credential_count <> 0 OR held.credential_account_id IS NOT NULL THEN
        RAISE EXCEPTION 'Provisioning account security correspondence unavailable' USING ERRCODE = '55000';
      END IF;
    ELSIF held.state = 'active' THEN
      IF credential_count <> 1 OR credential_row IS DISTINCT FROM held.credential_account_id THEN
        RAISE EXCEPTION 'Account security selected credential unavailable' USING ERRCODE = '55000';
      END IF;
      SELECT a.user_id, a.account_id, a.password IS NOT NULL AND a.password <> ''
        INTO credential_user, credential_account, credential_password_present
        FROM occ.account AS a WHERE a.id = credential_row AND a.provider_id = 'credential';
      IF NOT FOUND OR credential_user IS DISTINCT FROM p_account_id
        OR credential_account IS DISTINCT FROM p_account_id
        OR credential_password_present IS DISTINCT FROM true THEN
        RAISE EXCEPTION 'Account security selected credential mismatch' USING ERRCODE = '55000';
      END IF;
    ELSE
      RAISE EXCEPTION 'Unsupported account security state' USING ERRCODE = '55000';
    END IF;
  END IF;
  RETURN QUERY SELECT held.installation_id, held.account_id, held.issuer, held.subject,
    held.incarnation, held.account_version::text, held.state,
    held.current_user_id, held.credential_account_id;
END
$function$;

CREATE TRIGGER account_security_user_gate_v1
  BEFORE INSERT OR UPDATE OR DELETE ON occ."user"
  FOR EACH STATEMENT EXECUTE FUNCTION occ.account_security_writer_gate_v1();
CREATE TRIGGER account_security_account_gate_v1
  BEFORE INSERT OR UPDATE OR DELETE ON occ.account
  FOR EACH STATEMENT EXECUTE FUNCTION occ.account_security_writer_gate_v1();
CREATE TRIGGER account_security_user_insert_update_v1
  AFTER INSERT OR UPDATE ON occ."user"
  FOR EACH ROW EXECUTE FUNCTION occ.account_security_user_write_v1();
CREATE TRIGGER account_security_user_delete_v1
  BEFORE DELETE ON occ."user"
  FOR EACH ROW EXECUTE FUNCTION occ.account_security_user_write_v1();
CREATE TRIGGER account_security_credential_write_v1
  AFTER INSERT OR UPDATE OR DELETE ON occ.account
  FOR EACH ROW EXECUTE FUNCTION occ.account_security_credential_write_v1();
CREATE TRIGGER account_security_record_guard_v1
  BEFORE INSERT OR UPDATE OR DELETE ON occ.account_security_records
  FOR EACH ROW EXECUTE FUNCTION occ.account_security_record_guard_v1();
CREATE TRIGGER account_security_user_no_truncate_v1
  BEFORE TRUNCATE ON occ."user"
  FOR EACH STATEMENT EXECUTE FUNCTION occ.account_security_refuse_truncate_v1();
CREATE TRIGGER account_security_account_no_truncate_v1
  BEFORE TRUNCATE ON occ.account
  FOR EACH STATEMENT EXECUTE FUNCTION occ.account_security_refuse_truncate_v1();
CREATE TRIGGER account_security_record_no_truncate_v1
  BEFORE TRUNCATE ON occ.account_security_records
  FOR EACH STATEMENT EXECUTE FUNCTION occ.account_security_refuse_truncate_v1();

-- The reader and record are owner-only. No app-role EXECUTE or table DML grant
-- is made here; B1 scoped login/operator enrollment is separately allocated.
REVOKE ALL ON TABLE occ.account_security_records FROM PUBLIC;
REVOKE ALL ON FUNCTION occ.account_security_installation_v1() FROM PUBLIC;
REVOKE ALL ON FUNCTION occ.account_security_writer_gate_v1() FROM PUBLIC;
REVOKE ALL ON FUNCTION occ.account_security_refuse_truncate_v1() FROM PUBLIC;
REVOKE ALL ON FUNCTION occ.account_security_record_guard_v1() FROM PUBLIC;
REVOKE ALL ON FUNCTION occ.account_security_user_write_v1() FROM PUBLIC;
REVOKE ALL ON FUNCTION occ.account_security_credential_write_v1() FROM PUBLIC;
REVOKE ALL ON FUNCTION occ.read_locked_account_security_v1(text, text, text, text) FROM PUBLIC;
DO $block$
BEGIN
  -- Existing installation defaults can grant new tables to occ_app. Remove
  -- those inherited creation defaults without inventing a role if it is absent.
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'occ_app') THEN
    REVOKE ALL ON TABLE occ.account_security_records FROM occ_app;
    REVOKE ALL ON FUNCTION occ.account_security_installation_v1() FROM occ_app;
    REVOKE ALL ON FUNCTION occ.account_security_writer_gate_v1() FROM occ_app;
    REVOKE ALL ON FUNCTION occ.account_security_refuse_truncate_v1() FROM occ_app;
    REVOKE ALL ON FUNCTION occ.account_security_record_guard_v1() FROM occ_app;
    REVOKE ALL ON FUNCTION occ.account_security_user_write_v1() FROM occ_app;
    REVOKE ALL ON FUNCTION occ.account_security_credential_write_v1() FROM occ_app;
    REVOKE ALL ON FUNCTION occ.read_locked_account_security_v1(text, text, text, text) FROM occ_app;
  END IF;
END
$block$;

DO $block$
BEGIN
  -- Reject unexpected creation-default grants only on these new objects.
  -- Effective owner-role membership/superuser custody remains the original
  -- operator's privilege boundary; this does not alter roles or default ACLs.
  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_class AS c
    CROSS JOIN LATERAL pg_catalog.aclexplode(
      COALESCE(c.relacl, pg_catalog.acldefault('r', c.relowner))
    ) AS privilege
    WHERE c.oid = 'occ.account_security_records'::pg_catalog.regclass
      AND privilege.grantee <> c.relowner
  ) OR EXISTS (
    SELECT 1 FROM pg_catalog.pg_proc AS p
    CROSS JOIN LATERAL pg_catalog.aclexplode(
      COALESCE(p.proacl, pg_catalog.acldefault('f', p.proowner))
    ) AS privilege
    WHERE p.oid IN (
      'occ.account_security_installation_v1()'::pg_catalog.regprocedure,
      'occ.account_security_writer_gate_v1()'::pg_catalog.regprocedure,
      'occ.account_security_refuse_truncate_v1()'::pg_catalog.regprocedure,
      'occ.account_security_record_guard_v1()'::pg_catalog.regprocedure,
      'occ.account_security_user_write_v1()'::pg_catalog.regprocedure,
      'occ.account_security_credential_write_v1()'::pg_catalog.regprocedure,
      'occ.read_locked_account_security_v1(text,text,text,text)'::pg_catalog.regprocedure
    ) AND privilege.grantee <> p.proowner
  ) THEN
    RAISE EXCEPTION 'Account security requires owner-only object privileges' USING ERRCODE = '42501';
  END IF;
END
$block$;

COMMIT;
