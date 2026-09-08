-- Row locking needs an UPDATE privilege; the existing identity trigger rejects
-- every attempted id update, including assigning the same value.
GRANT UPDATE (id) ON occ.installation TO occ_app;
--> statement-breakpoint
-- This grants only the original bootstrap writer barrier, not IAM mutation.
CREATE FUNCTION occ.lock_fresh_bootstrap_iam_v1() RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  LOCK TABLE occ.iam_identities, occ.iam_roles, occ.iam_groups,
    occ.iam_group_memberships, occ.iam_access_bindings, occ.iam_restrictions
    IN SHARE ROW EXCLUSIVE MODE;
END;
$$;
--> statement-breakpoint
ALTER FUNCTION occ.lock_fresh_bootstrap_iam_v1() OWNER TO occ_migrator;
--> statement-breakpoint
REVOKE ALL ON FUNCTION occ.lock_fresh_bootstrap_iam_v1() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION occ.lock_fresh_bootstrap_iam_v1() TO occ_app;
