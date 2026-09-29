-- Unregistered source supplier. No production migration or deployment is
-- implied. A privileged owner must provision an Installation's closed control
-- row and perform the maintenance transition before enabling password login.
BEGIN;

DO $$
BEGIN
  IF current_user <> 'occ_migrator' THEN
    RAISE EXCEPTION 'password budget requires the migration owner' USING ERRCODE = '42501';
  END IF;
END;
$$;

CREATE TABLE occ.password_attempt_budget_control (
  installation_id text PRIMARY KEY REFERENCES occ.installation(id),
  closed boolean NOT NULL DEFAULT true,
  active_epoch bigint NOT NULL DEFAULT 0 CHECK (active_epoch >= 0),
  key_confirmation bytea,
  max_attempts integer,
  window_seconds integer,
  max_rows integer,
  cleanup_limit integer,
  CHECK (
    (active_epoch = 0 AND key_confirmation IS NULL AND max_attempts IS NULL
     AND window_seconds IS NULL AND max_rows IS NULL AND cleanup_limit IS NULL AND closed)
    OR
    (active_epoch > 0 AND key_confirmation IS NOT NULL AND octet_length(key_confirmation) = 32
     AND max_attempts IS NOT NULL AND max_attempts > 0
     AND window_seconds IS NOT NULL AND window_seconds > 0
     AND max_rows IS NOT NULL AND max_rows > 0
     AND cleanup_limit IS NOT NULL AND cleanup_limit > 0)
  )
);

CREATE TABLE occ.password_attempt_budget_rows (
  installation_id text NOT NULL REFERENCES occ.password_attempt_budget_control(installation_id),
  epoch bigint NOT NULL CHECK (epoch > 0),
  subject_digest bytea NOT NULL CHECK (octet_length(subject_digest) = 32),
  attempts integer NOT NULL CHECK (attempts > 0),
  expires_at timestamptz NOT NULL,
  PRIMARY KEY (installation_id, epoch, subject_digest)
);
CREATE INDEX password_attempt_budget_expiry
  ON occ.password_attempt_budget_rows (installation_id, expires_at);

-- All maintenance writers use this same control-row lock before any key row.
-- There is intentionally no app-role grant on this function or either table.
CREATE FUNCTION occ.password_budget_close(p_installation text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  PERFORM 1 FROM occ.password_attempt_budget_control
    WHERE installation_id = p_installation FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'password budget is unavailable' USING ERRCODE = '55000';
  END IF;
  UPDATE occ.password_attempt_budget_control SET closed = true
    WHERE installation_id = p_installation;
END;
$$;

-- The operator must first close all admission paths and drain writers. The
-- locked row serializes participating transactions; it does not prove that an
-- unobserved external writer or an uncertain process was drained.
CREATE FUNCTION occ.password_budget_activate(
  p_installation text, p_epoch bigint, p_confirmation bytea,
  p_max_attempts integer, p_window_seconds integer, p_max_rows integer, p_cleanup_limit integer
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_control occ.password_attempt_budget_control%ROWTYPE;
  v_now timestamptz;
BEGIN
  SELECT * INTO v_control FROM occ.password_attempt_budget_control
    WHERE installation_id = p_installation FOR UPDATE;
  IF NOT FOUND OR NOT v_control.closed OR p_epoch IS NULL OR p_epoch <= v_control.active_epoch
     OR p_confirmation IS NULL OR octet_length(p_confirmation) <> 32
     OR p_max_attempts IS NULL OR p_max_attempts <= 0
     OR p_window_seconds IS NULL OR p_window_seconds <= 0
     OR p_max_rows IS NULL OR p_max_rows <= 0
     OR p_cleanup_limit IS NULL OR p_cleanup_limit <= 0 THEN
    RAISE EXCEPTION 'password budget activation refused' USING ERRCODE = '55000';
  END IF;
  v_now := clock_timestamp();
  IF EXISTS (SELECT 1 FROM occ.password_attempt_budget_rows
             WHERE installation_id = p_installation AND expires_at > v_now) THEN
    RAISE EXCEPTION 'password budget has live windows' USING ERRCODE = '55000';
  END IF;
  UPDATE occ.password_attempt_budget_control
  SET active_epoch = p_epoch, key_confirmation = p_confirmation,
      max_attempts = p_max_attempts, window_seconds = p_window_seconds,
      max_rows = p_max_rows, cleanup_limit = p_cleanup_limit, closed = false
  WHERE installation_id = p_installation;
END;
$$;

CREATE FUNCTION occ.reserve_password_attempt(
  p_installation text, p_epoch bigint, p_confirmation bytea, p_digest bytea
) RETURNS TABLE(status text, retry_after_seconds integer)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_control occ.password_attempt_budget_control%ROWTYPE;
  v_row occ.password_attempt_budget_rows%ROWTYPE;
  v_found boolean;
  v_now timestamptz;
  v_rows bigint;
BEGIN
  IF p_installation IS NULL OR p_installation = '' OR p_epoch IS NULL OR p_epoch <= 0
     OR p_confirmation IS NULL OR octet_length(p_confirmation) <> 32
     OR p_digest IS NULL OR octet_length(p_digest) <> 32 THEN
    RAISE EXCEPTION 'password budget is unavailable' USING ERRCODE = '55000';
  END IF;
  SELECT * INTO v_control FROM occ.password_attempt_budget_control
    WHERE installation_id = p_installation FOR UPDATE;
  IF NOT FOUND OR v_control.closed OR v_control.active_epoch <> p_epoch
     OR v_control.key_confirmation IS DISTINCT FROM p_confirmation THEN
    RAISE EXCEPTION 'password budget is unavailable' USING ERRCODE = '55000';
  END IF;
  SELECT * INTO v_row FROM occ.password_attempt_budget_rows
    WHERE installation_id = p_installation AND epoch = p_epoch AND subject_digest = p_digest
    FOR UPDATE;
  v_found := FOUND;
  -- Sample after both control and key waits, never at transaction start.
  v_now := clock_timestamp();
  IF v_found AND v_row.expires_at > v_now THEN
    IF v_row.attempts >= v_control.max_attempts THEN
      RETURN QUERY SELECT 'limited'::text,
        GREATEST(1, CEIL(EXTRACT(EPOCH FROM (v_row.expires_at - v_now)))::integer);
      RETURN;
    END IF;
    UPDATE occ.password_attempt_budget_rows SET attempts = attempts + 1
      WHERE installation_id = p_installation AND epoch = p_epoch AND subject_digest = p_digest;
    RETURN QUERY SELECT 'allowed'::text, NULL::integer;
    RETURN;
  END IF;

  IF v_found THEN
    UPDATE occ.password_attempt_budget_rows
      SET attempts = 1, expires_at = v_now + make_interval(secs => v_control.window_seconds)
      WHERE installation_id = p_installation AND epoch = p_epoch AND subject_digest = p_digest;
  ELSE
    -- A serialized, bounded cleanup; no live row may be evicted.
    DELETE FROM occ.password_attempt_budget_rows
    WHERE ctid IN (
      SELECT ctid FROM occ.password_attempt_budget_rows
      WHERE installation_id = p_installation AND expires_at <= v_now
      ORDER BY expires_at, epoch, subject_digest
      LIMIT v_control.cleanup_limit FOR UPDATE
    );
    SELECT count(*) INTO v_rows FROM occ.password_attempt_budget_rows
      WHERE installation_id = p_installation;
    IF v_rows >= v_control.max_rows THEN
      -- Preserve bounded cleanup when the caller acknowledges COMMIT, while
      -- refusing password work. An unknown COMMIT remains unknown.
      RETURN QUERY SELECT 'unavailable'::text, NULL::integer;
      RETURN;
    END IF;
    -- Cleanup can wait for a row; start the new window after that wait.
    v_now := clock_timestamp();
    INSERT INTO occ.password_attempt_budget_rows
      (installation_id, epoch, subject_digest, attempts, expires_at)
      VALUES (p_installation, p_epoch, p_digest, 1,
              v_now + make_interval(secs => v_control.window_seconds));
  END IF;
  RETURN QUERY SELECT 'allowed'::text, NULL::integer;
END;
$$;

REVOKE ALL ON TABLE occ.password_attempt_budget_control, occ.password_attempt_budget_rows
  FROM PUBLIC, occ_app;
REVOKE ALL ON FUNCTION occ.password_budget_close(text) FROM PUBLIC, occ_app;
REVOKE ALL ON FUNCTION occ.password_budget_activate(text, bigint, bytea, integer, integer, integer, integer)
  FROM PUBLIC, occ_app;
REVOKE ALL ON FUNCTION occ.reserve_password_attempt(text, bigint, bytea, bytea) FROM PUBLIC, occ_app;
GRANT EXECUTE ON FUNCTION occ.reserve_password_attempt(text, bigint, bytea, bytea) TO occ_app;

-- Refuse inherited or SET ROLE access rather than silently assuming a direct
-- REVOKE eliminated the application role's effective privileges.
DO $$
DECLARE
  unexpected boolean;
  admin_authority boolean;
  app_oid oid;
BEGIN
  SELECT oid INTO app_oid FROM pg_catalog.pg_roles WHERE rolname = 'occ_app';
  WITH RECURSIVE reachable(roleid) AS (
    SELECT oid FROM pg_catalog.pg_roles WHERE rolname = 'occ_app'
    UNION
    SELECT m.roleid FROM pg_catalog.pg_auth_members m
      JOIN reachable r ON m.member = r.roleid WHERE m.set_option
  )
  SELECT count(*) > 1 INTO unexpected FROM reachable;
  -- ADMIN can grant SET to the member even when the present membership has
  -- SET FALSE and INHERIT FALSE. Include direct authority and authority held
  -- by any role whose privileges the application inherits.
  WITH RECURSIVE inherited(roleid) AS (
    SELECT oid FROM pg_catalog.pg_roles WHERE rolname = 'occ_app'
    UNION
    SELECT m.roleid FROM pg_catalog.pg_auth_members m
      JOIN inherited r ON m.member = r.roleid WHERE m.inherit_option
  )
  SELECT EXISTS (
    SELECT 1 FROM pg_catalog.pg_auth_members m
      JOIN inherited r ON m.member = r.roleid WHERE m.admin_option
  ) INTO admin_authority;
  IF unexpected OR app_oid IS NULL
     OR has_table_privilege('occ_app', 'occ.password_attempt_budget_control', 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN')
     OR has_table_privilege('occ_app', 'occ.password_attempt_budget_rows', 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN')
     OR has_function_privilege('occ_app', 'occ.password_budget_close(text)', 'EXECUTE')
     OR has_function_privilege('occ_app', 'occ.password_budget_activate(text,bigint,bytea,integer,integer,integer,integer)', 'EXECUTE') THEN
    RAISE EXCEPTION 'password budget application privileges are unsafe' USING ERRCODE = '42501';
  END IF;
  -- Default privileges may have granted other roles access to new objects.
  -- Reject that catalog rather than assuming direct PUBLIC/app revokes suffice.
  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_class c,
      LATERAL pg_catalog.aclexplode(COALESCE(c.relacl, pg_catalog.acldefault('r', c.relowner))) a
    WHERE c.oid IN ('occ.password_attempt_budget_control'::regclass,
                    'occ.password_attempt_budget_rows'::regclass)
      AND a.grantee <> c.relowner
  ) OR EXISTS (
    SELECT 1 FROM pg_catalog.pg_proc p,
      LATERAL pg_catalog.aclexplode(COALESCE(p.proacl, pg_catalog.acldefault('f', p.proowner))) a
    WHERE p.oid IN ('occ.password_budget_close(text)'::regprocedure,
                    'occ.password_budget_activate(text,bigint,bytea,integer,integer,integer,integer)'::regprocedure,
                    'occ.reserve_password_attempt(text,bigint,bytea,bytea)'::regprocedure)
      AND a.grantee <> p.proowner
      AND NOT (p.oid = 'occ.reserve_password_attempt(text,bigint,bytea,bytea)'::regprocedure
               AND a.grantee = app_oid AND a.privilege_type = 'EXECUTE' AND NOT a.is_grantable)
  ) THEN
    RAISE EXCEPTION 'password budget object privileges are unsafe' USING ERRCODE = '42501';
  END IF;
  -- Diagnose ADMIN only after every other unsafe-role/object check passed.
  IF admin_authority THEN
    RAISE EXCEPTION 'password budget application has role administration authority' USING ERRCODE = '42501';
  END IF;
END;
$$;

COMMIT;
