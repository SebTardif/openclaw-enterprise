-- Preserve account records and their original Installation lock domain. Session
-- statements join that domain before target tuples, including cascades/bulk DML.
-- Source-only successor; scoped login/operator enrollment is separately owned.
BEGIN;

CREATE OR REPLACE FUNCTION occ.account_security_writer_gate_v1()
RETURNS trigger LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  canonical_installation text;
BEGIN
  IF TG_LEVEL <> 'STATEMENT' OR TG_WHEN <> 'BEFORE' OR TG_TABLE_SCHEMA <> 'occ'
    OR TG_TABLE_NAME NOT IN ('user', 'account', 'session') OR TG_OP NOT IN ('INSERT', 'UPDATE', 'DELETE') THEN
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

CREATE TRIGGER account_security_session_gate_v1
  BEFORE INSERT OR UPDATE OR DELETE ON occ.session
  FOR EACH STATEMENT EXECUTE FUNCTION occ.account_security_writer_gate_v1();
CREATE TRIGGER account_security_session_no_truncate_v1
  BEFORE TRUNCATE ON occ.session
  FOR EACH STATEMENT EXECUTE FUNCTION occ.account_security_refuse_truncate_v1();

CREATE FUNCTION occ.read_locked_workload_profile_session_v1(
  p_installation_id text, p_account_id text, p_issuer text, p_subject text,
  p_session_id text, p_session_credential_digest text
)
RETURNS TABLE (
  installation_id text, account_id text, issuer text, subject text, incarnation uuid,
  account_version text, state text, current_user_id text, credential_account_id text,
  session_id text, session_user_id text, session_credential_digest text,
  session_expires_at timestamptz, remaining_ms text
)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  account_record record;
  session_record occ.session%ROWTYPE;
  locked_session text;
  sampled_now timestamptz;
  milliseconds numeric;
  credential_digest text;
BEGIN
  IF pg_catalog.current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'Profile session security requires READ COMMITTED' USING ERRCODE = '25001';
  END IF;
  IF p_session_id IS NULL OR char_length(p_session_id) NOT BETWEEN 1 AND 200
    OR p_session_credential_digest IS NULL
    OR p_session_credential_digest !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'Profile session lookup is invalid' USING ERRCODE = '23514';
  END IF;
  -- Original helper owns canonical Installation shared advisory prefix, account
  -- record SHARE and fresh user/credential reads. A row alone does not imply active.
  SELECT r.* INTO account_record
    FROM occ.read_locked_account_security_v1(
      p_installation_id, p_account_id, p_issuer, p_subject
    ) AS r;
  IF NOT FOUND THEN RETURN; END IF;
  IF account_record.state IS DISTINCT FROM 'active'
    OR account_record.current_user_id IS DISTINCT FROM p_account_id
    OR account_record.credential_account_id IS NULL THEN RETURN; END IF;

  SELECT s.id INTO locked_session FROM occ.session AS s
    WHERE s.id = p_session_id AND s.user_id = account_record.current_user_id
    FOR SHARE;
  IF NOT FOUND THEN RETURN; END IF;
  -- Separate fresh statement after any row-lock wait. The same shared advisory
  -- prefix excludes all supported user/account/session writers until terminal.
  SELECT s.* INTO session_record FROM occ.session AS s WHERE s.id = locked_session;
  IF NOT FOUND OR session_record.user_id IS DISTINCT FROM account_record.current_user_id
    OR session_record.token IS NULL OR session_record.token = '' THEN RETURN; END IF;
  IF occ.account_security_installation_v1() IS DISTINCT FROM p_installation_id THEN
    RAISE EXCEPTION 'Profile session Installation changed' USING ERRCODE = '55000';
  END IF;
  credential_digest := pg_catalog.encode(
    pg_catalog.sha256(pg_catalog.convert_to(session_record.token, 'UTF8')), 'hex'
  );
  IF credential_digest IS DISTINCT FROM p_session_credential_digest THEN RETURN; END IF;
  sampled_now := pg_catalog.clock_timestamp();
  milliseconds := pg_catalog.floor(EXTRACT(EPOCH FROM (session_record.expires_at - sampled_now)) * 1000);
  IF milliseconds IS NULL OR milliseconds <= 0 OR milliseconds > 9007199254740991 THEN RETURN; END IF;
  RETURN QUERY SELECT account_record.installation_id, account_record.account_id,
    account_record.issuer, account_record.subject, account_record.incarnation,
    account_record.account_version, account_record.state,
    account_record.current_user_id, account_record.credential_account_id,
    session_record.id, session_record.user_id, credential_digest,
    session_record.expires_at, milliseconds::text;
END
$function$;

-- The existing gate retains its owner. No new login, membership, direct session
-- SELECT or automatic application-role execution capability is introduced.
REVOKE ALL ON FUNCTION occ.account_security_writer_gate_v1() FROM PUBLIC;
REVOKE ALL ON FUNCTION occ.read_locked_workload_profile_session_v1(text,text,text,text,text,text) FROM PUBLIC;
DO $block$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'occ_app') THEN
    REVOKE ALL ON FUNCTION occ.account_security_writer_gate_v1() FROM occ_app;
    REVOKE ALL ON FUNCTION occ.read_locked_workload_profile_session_v1(text,text,text,text,text,text) FROM occ_app;
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_proc AS p
    CROSS JOIN LATERAL pg_catalog.aclexplode(
      COALESCE(p.proacl, pg_catalog.acldefault('f', p.proowner))
    ) AS privilege
    WHERE p.oid IN (
      'occ.account_security_writer_gate_v1()'::pg_catalog.regprocedure,
      'occ.read_locked_workload_profile_session_v1(text,text,text,text,text,text)'::pg_catalog.regprocedure
    ) AND privilege.grantee <> p.proowner
  ) THEN
    RAISE EXCEPTION 'Profile session security requires owner-only helper privileges' USING ERRCODE = '42501';
  END IF;
END
$block$;

COMMIT;
